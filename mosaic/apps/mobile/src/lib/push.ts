import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { supabase } from './supabase.ts';

/**
 * Registers this device for the digest pushes the worker sends.
 *
 * Fails quietly: a declined notification permission is a preference, not an
 * error, and must not block anyone from using the album.
 */
export async function registerForPush(): Promise<string | null> {
  if (!Device.isDevice) return null; // simulators have no push token

  const existing = await Notifications.getPermissionsAsync();
  const granted =
    existing.granted ||
    (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) return null;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('albums', {
      name: 'Albumupdates',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
  const { data: token } = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  );

  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return token;

  await supabase.from('push_tokens').upsert(
    {
      user_id: auth.user.id,
      token,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,token' },
  );

  return token;
}
