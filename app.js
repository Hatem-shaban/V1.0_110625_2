// Supabase client setup
import { createClient } from 'https://esm.sh/@supabase/supabase-js'

const supabaseUrl = 'https://ygnrdquwnafkbkxirtae.supabase.co'
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlnbnJkcXV3bmFma2JreGlydGFlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDgxNTY3MjMsImV4cCI6MjA2MzczMjcyM30.R1QNPExVxHJ8wQjvkuOxfPH0Gf1KR4HOafaP3flPWaI'
const supabase = createClient(supabaseUrl, supabaseKey)

// Try to get service role key from meta tag (securely injected by server)
const getServiceRoleKey = () => {
    const serviceRoleKeyMeta = document.querySelector('meta[name="supabase-service-key"]')
    return serviceRoleKeyMeta ? serviceRoleKeyMeta.content : null
}

// Create admin client if service role key is available
const supabaseAdmin = (() => {
    const serviceRoleKey = getServiceRoleKey()
    return serviceRoleKey ? createClient(supabaseUrl, serviceRoleKey) : null
})()

// User management class
class UserManager {
    constructor(supabase) {
        this.supabase = supabase;
    }

    async signUp(email) {
        try {
            // Check if user exists
            const { data: existingUser } = await this.supabase
                .from('users')
                .select('*')
                .eq('email', email)
                .single();

            if (existingUser) {
                return existingUser;
            }

            // Create new user
            const { data: newUser, error } = await this.supabase
                .from('users')
                .insert([{
                    email: email,
                    created_at: new Date().toISOString(),
                    subscription_status: 'pending'
                }])
                .select()
                .single();

            if (error) throw error;
            return newUser;

        } catch (error) {
            console.error('User signup error:', error);
            throw error;
        }
    }

    async trackToolUsage(userId, toolName, action, result) {
        try {
            const { error } = await this.supabase
                .from('tool_usage')
                .insert([{
                    user_id: userId,
                    tool_name: toolName,
                    action: action,
                    result: result,
                    created_at: new Date().toISOString()
                }]);

            if (error) throw error;
        } catch (error) {
            console.error('Tool usage tracking error:', error);
        }
    }
}

// AI Tool Functions
class StartupStackAI {
    async callAIOperation(operation, params) {
        try {
            const response = await fetch('/.netlify/functions/ai-operations', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    operation,
                    params
                })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || `HTTP error! status: ${response.status}`);
            }

            if (data.error) {
                throw new Error(data.error);
            }

            return data.result;
        } catch (error) {
            console.error('AI operation error:', error);
            throw new Error(`AI Operation failed: ${error.message}`);
        }
    }

    // Update all AI tool methods to use callAIOperation
    async generateBusinessNames(industry, keywords) {
        return this.callAIOperation('generateBusinessNames', { industry, keywords });
    }

    async generateLogo(style, industry) {
        return this.callAIOperation('generateLogo', { style, industry });
    }

    async generatePitchDeck(type, industry) {
        return this.callAIOperation('generatePitchDeck', { type, industry });
    }

    async analyzeMarket(industry, region) {
        return this.callAIOperation('analyzeMarket', { industry, region });
    }

    async generateContentCalendar(business, audience) {
        return this.callAIOperation('generateContentCalendar', { business, audience });
    }

    async generateEmailTemplates(business, sequence) {
        return this.callAIOperation('generateEmailTemplates', { business, sequence });
    }

    async generateLegalDocs(business, docType) {
        return this.callAIOperation('generateLegalDocs', { business, docType });
    }

    async generateFinancials(business, timeframe) {
        return this.callAIOperation('generateFinancials', { business, timeframe });
    }
}

// Initialize and export
async function initializeStartupStack() {
    try {
        // Create instances
        const aiTools = new StartupStackAI();
        const userManager = new UserManager(supabase);
          const stack = {
            aiTools,
            userManager,
            supabase,
            supabaseAdmin, // Include admin client if available
            initialized: true
        };

        window.StartupStack = stack;
        console.log('StartupStack initialized successfully');
        return stack;
    } catch (error) {
        console.error('Error initializing StartupStack:', error);
        throw error;
    }
}

// Export the initialization promise
export default initializeStartupStack();