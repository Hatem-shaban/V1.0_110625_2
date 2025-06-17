-- Function to directly update plan_type for a user
-- This bypasses RLS policies by using security definer
CREATE OR REPLACE FUNCTION admin_set_plan_type(user_id UUID, new_plan_type TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER -- This makes the function execute with the privileges of the creator (should be superuser)
SET search_path = public
AS $$
BEGIN
  UPDATE public.users
  SET plan_type = new_plan_type,
      updated_at = NOW()
  WHERE id = user_id;
END;
$$;

-- Grant execute permission to authenticated users and anon
GRANT EXECUTE ON FUNCTION admin_set_plan_type TO authenticated, anon;

-- Create a trigger to log plan_type changes
CREATE TABLE IF NOT EXISTS plan_type_change_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  old_plan_type TEXT,
  new_plan_type TEXT NOT NULL,
  changed_at TIMESTAMPTZ DEFAULT NOW(),
  changed_by TEXT
);

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

CREATE TRIGGER log_plan_type_changes
AFTER UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION log_plan_type_change();

-- Update all existing records with blank plan_type based on selected_plan
UPDATE users
SET plan_type = 
  CASE
    WHEN selected_plan = 'price_1RasluE92IbV5FBUlp01YVZe' THEN 'Yearly Deal'
    WHEN selected_plan = 'price_1RYhAlE92IbV5FBUCtOmXIow' THEN 'Starter'    WHEN selected_plan = 'price_1RSdrmE92IbV5FBUV1zE2VhD' THEN 'Pro'
    ELSE 'Starter'
  END
WHERE plan_type IS NULL OR plan_type = '';
