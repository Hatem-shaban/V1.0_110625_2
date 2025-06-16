const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

// Validate environment variables
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    throw new Error('Missing Supabase configuration');
}

// Initialize Supabase with proper error handling
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
        auth: {
            persistSession: false
        }
    }
);

exports.handler = async (event, context) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers };
    }    try {
        if (event.httpMethod !== 'POST') {
            throw new Error('Method not allowed');
        }

        const { customerEmail, userId, priceId, isLifetimeDeal } = JSON.parse(event.body);
        console.log('Request body:', { customerEmail, userId, priceId, isLifetimeDeal });

        if (!customerEmail || !userId) {
            throw new Error('Missing required fields');
        }

        // Verify user exists
        const { data: existingUser, error: userError } = await supabase
            .from('users')
            .select('id, email, subscription_status')
            .eq('id', userId)
            .eq('email', customerEmail)
            .single();

        if (userError) {
            console.error('User verification error:', userError);
            return {
                statusCode: 404,
                headers,
                body: JSON.stringify({ error: 'User not found' })
            };        }          // Determine plan type based on the price ID
        let planType;
        let isLifetimePlan = false;
          // Log the priceId for debugging
        console.log('Processing checkout with priceId:', priceId);
          // Explicitly match price IDs to plan types
        if (priceId === 'price_1RYhAlE92IbV5FBUCtOmXIow') {
            console.log('Matched Starter plan');
            planType = 'Starter'; // Use consistent naming that matches what the database expects
        } else if (priceId === 'price_1RYhFGE92IbV5FBUqiKOcIqX') {            // Check if this is a lifetime deal based on the flag passed from frontend
            if (isLifetimeDeal === true) {
                console.log('Matched Lifetime Deal plan (via isLifetimeDeal flag)');
                planType = 'Lifetime Deal';
                isLifetimePlan = true;
            } else {
                console.log('Matched Pro plan');
                planType = 'Pro';
            }
        } else if (priceId === 'price_lifetime') { // Old Lifetime deal ID
            console.log('Matched Lifetime Deal plan (via legacy ID)');
            planType = 'Lifetime Deal';
            isLifetimePlan = true;
        } else {
            console.log('No match, defaulting to Starter plan');
            planType = 'Starter';
        }
        
        // Double check the final value to ensure it's what we expect
        console.log('Final plan_type value:', planType);
          // Create Stripe checkout session with specified price ID
        // For lifetime deals, we need to use payment mode instead of subscription mode
        const checkoutMode = isLifetimePlan ? 'payment' : 'subscription';
        console.log('Using checkout mode:', checkoutMode);
        
        // For lifetime deals, we might need a special price ID or amount-based setup
        let lineItems;
        
        if (isLifetimePlan) {
            // For lifetime deals, create a one-time payment
            lineItems = [{
                // Use amount_total for one-time payments
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'StartupStack Lifetime Access',
                        description: 'One-time payment for lifetime access to StartupStack',
                    },
                    unit_amount: 29700, // $297.00
                },
                quantity: 1,
            }];
        } else {
            // For subscriptions, use the provided price ID
            lineItems = [{
                price: priceId || process.env.STRIPE_PRICE_ID,
                quantity: 1,
            }];
        }
        
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: checkoutMode,
            line_items: lineItems,
            success_url: `${process.env.URL}/success.html?session_id={CHECKOUT_SESSION_ID}&userId=${userId}`,
            cancel_url: `${process.env.URL}?checkout=cancelled`,
            customer_email: customerEmail,
            metadata: {
                userId: userId,
                priceId: priceId || process.env.STRIPE_PRICE_ID
            }
        });        // Update user status with retry logic
        let retryCount = 0;
        const maxRetries = 3;
        let updateError;        // Log the values we're about to use for update
        console.log('Updating user with the following values:');
        console.log('- plan_type:', planType);
        console.log('- selected_plan:', priceId || process.env.STRIPE_PRICE_ID);
        console.log('- subscription_status:', isLifetimePlan ? 'pending_lifetime' : 'pending_activation');
        
        // Try to diagnose database schema issues by making a separate call to get column definitions
        try {
            // Query the database to check existing user data
            const { data: existingData, error: fetchError } = await supabase
                .from('users')
                .select('plan_type')
                .eq('id', userId)
                .single();
                
            if (fetchError) {
                console.error('Error fetching existing user data:', fetchError);
            } else {
                console.log('Current plan_type value in database:', existingData.plan_type);
            }
        } catch (e) {
            console.error('Error checking database schema:', e);
        }
        
        while (retryCount < maxRetries) {
            // Create update object explicitly to ensure clarity
            const updateData = {
                subscription_status: isLifetimePlan ? 'pending_lifetime' : 'pending_activation',
                stripe_session_id: session.id,
                plan_type: planType,  // This should be "Starter", "Pro", or "Lifetime Deal"
                selected_plan: priceId || process.env.STRIPE_PRICE_ID,
                updated_at: new Date().toISOString()
            };
            
            console.log('Update data:', JSON.stringify(updateData));
              // First, make a separate update just for plan_type to isolate any issues
            const { error: planTypeError } = await supabase
                .from('users')
                .update({ plan_type: planType })
                .eq('id', userId);
                
            if (planTypeError) {
                console.error('Error updating plan_type only:', planTypeError);
                console.error('Code:', planTypeError.code);
                console.error('Message:', planTypeError.message);
                console.error('Details:', planTypeError.details);
            } else {
                console.log('Successfully updated plan_type to:', planType);
            }
            
            // Now try the full update
            const { error } = await supabase
                .from('users')
                .update(updateData)
                .eq('id', userId);

            if (!error) {
                updateError = null;
                
                // Double-check that the plan_type was actually updated
                const { data: verifyData, error: verifyError } = await supabase
                    .from('users')
                    .select('plan_type')
                    .eq('id', userId)
                    .single();
                    
                if (verifyError) {
                    console.error('Error verifying plan_type update:', verifyError);
                } else {
                    console.log('Verified plan_type after update:', verifyData.plan_type);
                    if (verifyData.plan_type !== planType) {
                        console.warn('Warning: plan_type was not updated correctly in database!');
                        console.warn('Expected:', planType);
                        console.warn('Actual:', verifyData.plan_type);
                    }
                }
                
                break;
            }

            updateError = error;
            console.error('Update error details:');
            console.error('Code:', error.code);
            console.error('Message:', error.message);
            if (error.details) console.error('Details:', error.details);
            retryCount++;
            await new Promise(resolve => setTimeout(resolve, 1000 * retryCount)); // Exponential backoff
        }

        if (updateError) {
            console.error('Error updating user status after retries:', updateError);
            // Even if update fails, continue with checkout
            // The webhook will attempt to update the status again
        }

        return {
            statusCode: 200,
            headers,            body: JSON.stringify({ 
                id: session.id,
                userId: userId,
                success: true,
                plan_type: planType,
                mode: isLifetimePlan ? 'payment' : 'subscription'
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