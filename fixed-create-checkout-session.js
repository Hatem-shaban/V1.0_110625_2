const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

// Validate environment variables
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    throw new Error('Missing Supabase configuration');
}

// Initialize Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
        auth: {
            persistSession: false
        }
    }
);

// Initialize a service role client to bypass RLS policies if available
const supabaseAdmin = process.env.SUPABASE_SERVICE_ROLE_KEY ? 
    createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        {
            auth: {
                persistSession: false
            }
        }
    ) : supabase;

exports.handler = async (event, context) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    // Handle preflight requests
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers };
    }

    try {
        // Only allow POST requests
        if (event.httpMethod !== 'POST') {
            return {
                statusCode: 405,
                headers,
                body: JSON.stringify({ error: 'Method not allowed' })
            };
        }

        // Parse request body
        const requestBody = JSON.parse(event.body);
        const { customerEmail, userId, priceId } = requestBody;

        // Validate required fields
        if (!customerEmail || !userId || !priceId) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Missing required fields: customerEmail, userId, or priceId' })
            };
        }

        // Verify user exists
        const { data: existingUser, error: userError } = await supabase
            .from('users')
            .select('id, email')
            .eq('id', userId)
            .eq('email', customerEmail)
            .single();

        if (userError) {
            return {
                statusCode: 404,
                headers,
                body: JSON.stringify({ error: 'User not found' })
            };
        }

        // Direct mapping of price IDs to plan types
        const PRICE_TO_PLAN_MAP = {
            'price_1RasluE92IbV5FBUlp01YVZe': { name: 'Yearly Deal', status: 'yearly_active' },
            'price_1RYhAlE92IbV5FBUCtOmXIow': { name: 'Starter', status: 'pending_activation' },
            'price_1RSdrmE92IbV5FBUV1zE2VhD': { name: 'Pro', status: 'pending_activation' }
        };

        // Get plan details from the price ID
        const planDetails = PRICE_TO_PLAN_MAP[priceId];
        
        if (!planDetails) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Invalid price ID' })
            };
        }

        // Create checkout session with the correct mode
        const sessionParams = {
            payment_method_types: ['card'],
            mode: 'subscription',
            line_items: [{
                price: priceId,
                quantity: 1
            }],
            success_url: `${process.env.URL}/success.html?session_id={CHECKOUT_SESSION_ID}&userId=${userId}`,
            cancel_url: `${process.env.URL}?checkout=cancelled`,
            customer_email: customerEmail,
            metadata: {
                userId,
                planType: planDetails.name,
                priceId: priceId
            }
        };

        // Create the Stripe checkout session
        const session = await stripe.checkout.sessions.create(sessionParams);

        // Update user in the database with the new plan details
        const { error: updateError } = await supabaseAdmin
            .from('users')
            .update({
                subscription_status: 'pending_activation',
                plan_type: planDetails.name,
                selected_plan: priceId,
                stripe_session_id: session.id,
                updated_at: new Date().toISOString()
            })
            .eq('id', userId);

        if (updateError) {
            console.error('Error updating user:', updateError);
            // Continue with the checkout even if the update fails
            // The success page will handle setting plan_type as a fallback
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                id: session.id,
                userId: userId,
                success: true,
                plan_type: planDetails.name,
                mode: 'subscription'
            })
        };

    } catch (error) {
        console.error('Create checkout session error:', error);
        return {
            statusCode: error.statusCode || 500,
            headers,
            body: JSON.stringify({
                error: error.message,
                details: process.env.NODE_ENV === 'development' ? error : undefined
            })
        };
    }
};
