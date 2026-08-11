import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { Platform } from 'react-native';

import { supabase } from '../src/lib/supabase.ts';

export default function SignIn() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendMagicLink = async () => {
    setBusy(true);
    setError(null);
    const { error: authError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: 'mosaic://auth-callback' },
    });
    setBusy(false);
    if (authError) setError('Versturen mislukt. Klopt het e-mailadres?');
    else setSent(true);
  };

  const signInWithApple = async () => {
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!credential.identityToken) throw new Error('no_identity_token');

      const { error: authError } = await supabase.auth.signInWithIdToken({
        provider: 'apple',
        token: credential.identityToken,
      });
      if (authError) throw authError;
    } catch (caught) {
      // The user cancelling the sheet is not an error worth shouting about.
      if ((caught as { code?: string }).code !== 'ERR_REQUEST_CANCELED') {
        setError('Inloggen met Apple lukte niet.');
      }
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Mosaic</Text>
      <Text style={styles.subtitle}>Een gedeeld album van korte clips.</Text>

      {Platform.OS === 'ios' && (
        <AppleAuthentication.AppleAuthenticationButton
          buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
          buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
          cornerRadius={12}
          style={styles.appleButton}
          onPress={signInWithApple}
        />
      )}

      {sent ? (
        <Text style={styles.sent}>
          Check je mail — we hebben een inloglink naar {email.trim()} gestuurd.
        </Text>
      ) : (
        <>
          <TextInput
            style={styles.input}
            placeholder="jouw@email.nl"
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />
          <Pressable
            style={[styles.button, (!email.includes('@') || busy) && styles.buttonDisabled]}
            disabled={!email.includes('@') || busy}
            onPress={sendMagicLink}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Stuur inloglink</Text>}
          </Pressable>
        </>
      )}

      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 28, justifyContent: 'center', gap: 12 },
  title: { fontSize: 34, fontWeight: '700' },
  subtitle: { fontSize: 16, color: '#666', marginBottom: 28 },
  appleButton: { height: 48, marginBottom: 12 },
  input: { borderWidth: 1, borderColor: '#ddd', borderRadius: 12, padding: 14, fontSize: 16 },
  button: { backgroundColor: '#111', borderRadius: 12, padding: 16, alignItems: 'center' },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  sent: { fontSize: 15, color: '#333', lineHeight: 22 },
  error: { color: '#c0392b', marginTop: 8 },
});
