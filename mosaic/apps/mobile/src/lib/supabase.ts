import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY must be set — see .env.example',
  );
}

export const supabase = createClient(url, anonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    // React Native has no URL bar for the OAuth fragment to land in.
    detectSessionInUrl: false,
  },
});

/**
 * Postgres raises bare, greppable messages (`invite_expired`, `not_clip_author`).
 * supabase-js wraps them in prose, so pull the code back out for the UI.
 */
export function errorCode(error: unknown): string {
  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error);
  const match = message.match(/\b(invite_[a-z_]+|not_[a-z_]+|clip_[a-z_]+)\b/);
  return match?.[1] ?? 'unknown_error';
}

export const MESSAGES: Record<string, string> = {
  invite_not_found: 'Deze uitnodiging bestaat niet (meer).',
  invite_expired: 'Deze uitnodiging is verlopen. Vraag om een nieuwe link.',
  invite_revoked: 'Deze uitnodiging is ingetrokken.',
  invite_exhausted: 'Deze uitnodiging is al door het maximum aantal mensen gebruikt.',
  not_a_member: 'Je hebt geen toegang tot deze groep.',
  not_clip_author: 'Je kunt alleen je eigen clips verwijderen.',
  unknown_error: 'Er ging iets mis. Probeer het opnieuw.',
};

export const humanError = (error: unknown): string =>
  MESSAGES[errorCode(error)] ?? MESSAGES.unknown_error;
