ALTER TABLE public.inscriptions
ADD COLUMN IF NOT EXISTS admin_force_confirm boolean NOT NULL DEFAULT false;
