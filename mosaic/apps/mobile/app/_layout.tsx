import { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { SessionProvider, useSession } from '../src/lib/session.tsx';
import { registerForPush } from '../src/lib/push.ts';

function Gate() {
  const { session, loading } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    // /join/<token> stays reachable signed out: the invite screen explains what
    // you were invited to *before* asking you to make an account.
    const isPublic = segments[0] === 'sign-in' || segments[0] === 'join';

    if (!session && !isPublic) router.replace('/sign-in');
    if (session && segments[0] === 'sign-in') router.replace('/');
  }, [session, loading, segments, router]);

  useEffect(() => {
    if (session) void registerForPush();
  }, [session]);

  return (
    <Stack screenOptions={{ headerShadowVisible: false }}>
      <Stack.Screen name="index" options={{ title: 'Albums' }} />
      <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      <Stack.Screen name="albums/new" options={{ title: 'Nieuw album', presentation: 'modal' }} />
      <Stack.Screen name="albums/[id]/index" options={{ title: '' }} />
      <Stack.Screen name="albums/[id]/camera" options={{ headerShown: false, presentation: 'fullScreenModal' }} />
      <Stack.Screen name="albums/[id]/play" options={{ headerShown: false, presentation: 'fullScreenModal' }} />
      <Stack.Screen name="albums/[id]/invite" options={{ title: 'Uitnodigen', presentation: 'modal' }} />
      <Stack.Screen name="join/[token]" options={{ title: 'Uitnodiging' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SessionProvider>
      <StatusBar style="auto" />
      <Gate />
    </SessionProvider>
  );
}
