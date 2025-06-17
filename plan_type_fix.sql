-- Update constraint to allow "Yearly Deal" as a valid plan type
DO $$
BEGIN
  -- Drop the constraint if it exists
  BEGIN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS valid_plan_type;
  EXCEPTION
    WHEN undefined_object THEN
      RAISE NOTICE 'Constraint valid_plan_type does not exist, will create new one';
  END;
  
  -- Create the constraint with the updated values
  ALTER TABLE users
  ADD CONSTRAINT valid_plan_type
  CHECK (plan_type IN ('Free', 'Starter', 'Pro', 'Yearly Deal'));
END $$;

-- Create a logging function to track plan type changes
CREATE TABLE IF NOT EXISTS plan_type_change_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  old_plan_type TEXT,
  new_plan_type TEXT NOT NULL,
  changed_at TIMESTAMPTZ DEFAULT NOW(),
  changed_by TEXT
);

-- Create or replace the logging trigger function
CREATE OR REPLACE FUNCTION log_plan_type_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.plan_type IS DISTINCT FROM NEW.plan_type THEN
    INSERT INTO plan_type_change_log (user_id, old_plan_type, new_plan_type, changed_by)
    VALUES (NEW.id, OLD.plan_type, NEW.plan_type, current_user);
  END IF;
  RETURN NEW;
END;
$$;

-- Create the trigger if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'log_plan_type_changes'
  ) THEN
    CREATE TRIGGER log_plan_type_changes
    AFTER UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION log_plan_type_change();
  END IF;
END $$;

-- DIRECT PLAN TYPE MANAGEMENT
-- Simple, clear approach to ensure plan_types match selected_plan values

-- 1. Show current state for reference (before update)
SELECT 
  id, 
  email, 
  plan_type, 
  selected_plan, 
  subscription_status 
FROM 
  users
ORDER BY 
  created_at DESC
LIMIT 10;

-- 2. Direct mapping of price IDs to plan types
-- This ensures plan_type is always aligned with the selected_plan
UPDATE users
SET 
  plan_type = CASE
    WHEN selected_plan = 'price_1RasluE92IbV5FBUlp01YVZe' THEN 'Yearly Deal'
    WHEN selected_plan = 'price_1RYhAlE92IbV5FBUCtOmXIow' THEN 'Starter'
    WHEN selected_plan = 'price_1RSdrmE92IbV5FBUV1zE2VhD' THEN 'Pro'
    ELSE plan_type -- Keep existing plan_type if no selected_plan match
  END,
  updated_at = NOW()
WHERE 
  selected_plan IS NOT NULL;

-- 3. Set the correct subscription_status for yearly plans
UPDATE users
SET 
  subscription_status = 'yearly_active'
WHERE 
  plan_type = 'Yearly Deal' AND
  subscription_status IS DISTINCT FROM 'yearly_active';

-- 4. Verify the changes were applied correctly
SELECT 
  id, 
  email, 
  plan_type, 
  selected_plan, 
  subscription_status 
FROM 
  users
ORDER BY 
  updated_at DESC
LIMIT 10;

-- 5. Summary of plan types and selected plans for verification
SELECT 
  plan_type, 
  selected_plan, 
  COUNT(*) as user_count
FROM 
  users
GROUP BY 
  plan_type, selected_plan
ORDER BY 
  plan_type;
