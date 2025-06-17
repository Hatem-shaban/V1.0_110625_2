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

// Initialize a service role client to bypass RLS policies
// NOTE: You'll need to add SUPABASE_SERVICE_ROLE_KEY to your Netlify environment variables
const supabaseAdmin = process.env.SUPABASE_SERVICE_ROLE_KEY ? 
    createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        {
            auth: {
                persistSession: false
            }
        }
    ) : supabase; // Fallback to regular client if no service role key

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
        }                // Parse request body
        const requestBody = JSON.parse(event.body);
        const { customerEmail, userId, priceId, planType: requestedPlanType } = requestBody;
        
        // DETAILED DEBUG FOR DIRECT API REQUEST
        console.log('-------------------------------------------');
        console.log('🚨 CHECKOUT SESSION CREATION - REQUEST DATA');
        console.log('-------------------------------------------');
        
        console.log(`priceId: "${priceId}" (${typeof priceId})`);
        console.log(`requestedPlanType: "${requestedPlanType}" (${typeof requestedPlanType})`);        console.log(`isYearlyDeal flag: ${requestBody.isYearlyDeal} (${typeof requestBody.isYearlyDeal})`);
        
        // Check exact values against known good ones
        console.log('priceId matches:');
        console.log('- Is price_1RasluE92IbV5FBUlp01YVZe?', priceId === 'price_1RasluE92IbV5FBUlp01YVZe');
        console.log('- Is price_1RYhAlE92IbV5FBUCtOmXIow?', priceId === 'price_1RYhAlE92IbV5FBUCtOmXIow');
        console.log('- Is price_1RSdrmE92IbV5FBUV1zE2VhD?', priceId === 'price_1RSdrmE92IbV5FBUV1zE2VhD');
          // Check for yearly deal in multiple ways to be extra safe
        const isYearlyDeal = 
            requestBody.isYearlyDeal === true || 
            priceId === 'price_1RasluE92IbV5FBUlp01YVZe';
            
        console.log('Full request body:', JSON.stringify(requestBody, null, 2));        console.log('Parsed checkout info:', { 
            customerEmail, 
            userId, 
            priceId, 
            isYearlyDeal,
            isYearlyDealFromRequest: requestBody.isYearlyDeal,
            requestedPlanType
        });
        console.log('-------------------------------------------');

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
          // HANDLE YEARLY DEALS - check for special yearly price ID
        if (isYearlyDeal || priceId === 'price_1RasluE92IbV5FBUlp01YVZe') {
            console.log('Creating YEARLY DEAL checkout - setting mode to subscription');
            planType = 'Yearly Deal'; // Always override for yearly deals
            subscriptionStatus = 'pending_activation';
            
            sessionParams = {
                payment_method_types: ['card'],
                mode: 'subscription',  // Yearly subscription
                line_items: [{
                    price: 'price_1RasluE92IbV5FBUlp01YVZe',
                    quantity: 1,
                }]
            };
        } 
        // HANDLE REGULAR SUBSCRIPTIONS
        else {
            console.log('Creating SUBSCRIPTION checkout with priceId:', priceId);
            subscriptionStatus = 'pending_activation';
              // Determine plan type based on the price ID
            // UPDATED PRICE ID MAPPING
            console.log('Determining plan type from price ID:', priceId);
            if (priceId === 'price_1RYhAlE92IbV5FBUCtOmXIow') {
                planType = 'Starter';
                console.log('Matched to Starter plan');
            } else if (priceId === 'price_1RSdrmE92IbV5FBUV1zE2VhD') {
                planType = 'Pro'; 
                console.log('Matched to Pro plan');
            } else if (priceId === 'price_1RYhFGE92IbV5FBUqiKOcIqX') {
                // Keep this for backward compatibility
                planType = 'Pro';
                console.log('Matched to Pro plan (legacy ID)');
            } else {
                console.log('No price ID match found, defaulting to Starter');
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
            // IMPORTANT: Use supabaseAdmin to bypass RLS policies
            console.log(`Attempt ${retryCount + 1}/${maxRetries} to update user ${userId} using ${supabaseAdmin === supabase ? 'regular client' : 'admin client'}`);
            const updateResult = await supabaseAdmin
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
                    
                if (!verifyError) {            console.log('Verified user update:', verifyData);
                    
                    // DIRECT SQL UPDATE AS LAST RESORT
                    // This bypasses any RLS policies or Supabase client issues
                    try {
                        // Only do this if there's still an issue with plan_type
                        if (!verifyData.plan_type || verifyData.plan_type === '') {
                            console.log('🚨 CRITICAL: plan_type still empty after update, trying direct SQL...');
                            
                            // Use RPC call to execute SQL directly
                            const { error: rpcError } = await supabaseAdmin.rpc('admin_set_plan_type', { 
                                user_id: userId,
                                new_plan_type: planType
                            });
                            
                            if (rpcError) {
                                console.error('Direct SQL update failed:', rpcError);
                            } else {
                                console.log('Direct SQL update succeeded!');
                            }
                        }
                    } catch (sqlError) {
                        console.error('Error in direct SQL update:', sqlError);
                    }
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
