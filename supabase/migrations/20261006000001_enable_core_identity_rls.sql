ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_details ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_select_own
    ON public.profiles
    FOR SELECT
    TO authenticated
    USING (auth.uid() = auth_user_id);
