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
    }

    try {
        if (event.httpMethod !== 'POST') {
            throw new Error('Method not allowed');
        }        // Parse request body
        const requestBody = JSON.parse(event.body);
        const { customerEmail, userId, priceId, planType: requestedPlanType } = requestBody;
        
        // Check for lifetime deal in multiple ways to be extra safe
        const isLifetimeDeal = 
            requestBody.isLifetimeDeal === true || 
            priceId === 'price_lifetime_deal_297';
            
        console.log('Full request body:', requestBody);
        console.log('Parsed checkout info:', { 
            customerEmail, 
            userId, 
            priceId, 
            isLifetimeDeal,
            isLifetimeDealFromRequest: requestBody.isLifetimeDeal,
            requestedPlanType
        });

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
            };
        }        // Determine plan type and create appropriate checkout session
        // If frontend sent a planType, prefer that over determining it here
        let planType = requestedPlanType || null;
        let sessionParams;
        let subscriptionStatus;
        
        console.log('Price ID received:', priceId);
        console.log('Plan type from request:', planType);
        
        // HANDLE LIFETIME DEALS - now check for special lifetime price ID
        if (isLifetimeDeal || priceId === 'price_lifetime_deal_297') {
            console.log('Creating LIFETIME DEAL checkout - explicitly setting mode to payment');
            planType = 'Lifetime Deal'; // Always override for lifetime deals
            subscriptionStatus = 'pending_lifetime';
            
            sessionParams = {
                payment_method_types: ['card'],
                mode: 'payment',  // One-time payment
                line_items: [{
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: 'StartupStack Lifetime Access',
                            description: 'One-time payment for lifetime access to all StartupStack tools',
                        },
                        unit_amount: 29700, // $297.00
                    },
                    quantity: 1,
                }]
            };
        } 
        // HANDLE REGULAR SUBSCRIPTIONS
        else {
            console.log('Creating SUBSCRIPTION checkout with priceId:', priceId);
            subscriptionStatus = 'pending_activation';
            
            // Determine plan type based on the price ID
            if (priceId === 'price_1RYhAlE92IbV5FBUCtOmXIow') {
                planType = 'Starter';
            } else if (priceId === 'price_1RYhFGE92IbV5FBUqiKOcIqX') {
                planType = 'Pro';
            } else {
                planType = 'Starter'; // Default
            }
            
            sessionParams = {
                payment_method_types: ['card'],
                mode: 'subscription',
                line_items: [{
                    price: priceId || process.env.STRIPE_PRICE_ID,
                    quantity: 1,
                }]
            };
        }
        
        // Add common parameters
        sessionParams = {
            ...sessionParams,
            success_url: `${process.env.URL}/success.html?session_id={CHECKOUT_SESSION_ID}&userId=${userId}`,
            cancel_url: `${process.env.URL}?checkout=cancelled`,
            customer_email: customerEmail,
            metadata: {
                userId,
                planType,
                priceId: priceId || 'lifetime_deal'
            }
        };
        
        console.log('Creating Stripe checkout session with mode:', sessionParams.mode);
        const session = await stripe.checkout.sessions.create(sessionParams);
        console.log('Checkout session created:', session.id);

        // Update user in the database
        let retryCount = 0;
        const maxRetries = 3;
        let updateError;
        
        console.log('Updating user with:', { 
            plan_type: planType, 
            selected_plan: priceId || 'lifetime_deal',
            subscription_status: subscriptionStatus
        });

        // Try to get current user data for debugging
        try {
            const { data: userData } = await supabase
                .from('users')
                .select('plan_type')
                .eq('id', userId)
                .single();
                  console.log('Current user data:', userData);
            console.log('Current plan_type value type:', typeof userData.plan_type);
            console.log('Is plan_type null?', userData.plan_type === null);
            console.log('Is plan_type empty string?', userData.plan_type === '');
        } catch (e) {
            console.error('Error fetching user data:', e);
        }
        
        // UPDATE THE USER - WITH ENHANCED DEBUGGING
        console.log('CRITICAL UPDATE OPERATION STARTING');
        
        // Update user data with retries
        while (retryCount < maxRetries) {
            const planTypeValue = planType || 'Starter'; // Ensure we have a fallback
            console.log('Using planType value:', planTypeValue, 'type:', typeof planTypeValue);
            
            const updateData = {
                subscription_status: subscriptionStatus,
                stripe_session_id: session.id,
                plan_type: planTypeValue, // Use our sanitized value
                selected_plan: priceId || 'lifetime_deal',
                updated_at: new Date().toISOString()
            };
            
            console.log('Update data (full):', JSON.stringify(updateData));
            
            // Try update with more specific debugging
            console.log(`Attempt ${retryCount + 1}/${maxRetries} to update user ${userId}`);
            const updateResult = await supabase
                .from('users')
                .update(updateData)
                .eq('id', userId);
                
            const { error } = updateResult;
            
            // Log the full result for debugging
            console.log('Supabase update result:', JSON.stringify(updateResult));

            if (!error) {
                updateError = null;
                
                // Verify update
                const { data: verifyData, error: verifyError } = await supabase
                    .from('users')
                    .select('plan_type, subscription_status')
                    .eq('id', userId)
                    .single();
                    
                if (!verifyError) {
                    console.log('Verified user update:', verifyData);
                }
                
                break;
            }

            updateError = error;
            console.error('Update error:', error);
            retryCount++;
            
            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
        }

        if (updateError) {
            console.error('Error updating user after retries:', updateError);
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ 
                id: session.id,
                userId: userId,
                success: true,
                plan_type: planType,
                mode: sessionParams.mode
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
