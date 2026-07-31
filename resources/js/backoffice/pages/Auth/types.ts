/**
 * Props for the auth screens.
 *
 * `Auth/Login` is the only one the contract declares (spec 05 §12) and the only one with a
 * server route (`routes/web.php`). `Auth/ForgotPassword`, `Auth/ResetPassword` and `Auth/Profile`
 * exist as components because the brief asks for them, and they render an explicit "not wired up"
 * state — see the note in each file. If the routes appear later, only the form targets change.
 */

export type LoginProps = {
    /** `AuthenticatedSessionController::create()` currently hardcodes `false`. */
    canResetPassword: boolean;
};

export type LoginForm = {
    email: string;
    password: string;
    remember: boolean;
};

export type ForgotPasswordProps = {
    status?: string | null;
};

export type ResetPasswordProps = {
    token?: string;
    email?: string;
};
