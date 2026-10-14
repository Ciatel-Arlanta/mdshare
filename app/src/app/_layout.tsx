import '@/global.css';

import { DarkTheme, DefaultTheme, type ErrorBoundaryProps, Stack, ThemeProvider, router } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useSyncExternalStore } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { Button, ButtonText } from '@/components/ui/button';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { Heading } from '@/components/ui/heading';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useDiscovery } from '@/lib/discovery';
import { useStore } from '@/lib/store';
import { useColors, useScheme } from '@/lib/theme';

SplashScreen.preventAutoHideAsync();

// Deep links ("Open with", pairing links) land on top of the home screen, so
// back always has somewhere to go.
export const unstable_settings = { initialRouteName: 'index' };

/** Shown instead of closing the app when a screen throws while rendering. */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <GluestackUIProvider mode={useStore.getState().prefs.appearance}>
      <VStack space="lg" className="flex-1 justify-center bg-background p-8">
        <Heading size="xl">Something went wrong</Heading>
        <Text className="text-muted-foreground">{error.message}</Text>
        <Button className="h-12 rounded-xl" onPress={retry}>
          <ButtonText>Try again</ButtonText>
        </Button>
        <Button
          variant="outline"
          className="h-12 rounded-xl"
          onPress={() => {
            router.dismissAll();
            router.replace('/');
          }}
        >
          <ButtonText>Go home</ButtonText>
        </Button>
      </VStack>
    </GluestackUIProvider>
  );
}

function useHydrated() {
  return useSyncExternalStore(useStore.persist.onFinishHydration, useStore.persist.hasHydrated);
}

export default function RootLayout() {
  const hydrated = useHydrated();
  const appearance = useStore((s) => s.prefs.appearance);
  const scheme = useScheme();
  const colors = useColors();
  useDiscovery();

  useEffect(() => {
    if (hydrated) void SplashScreen.hideAsync();
  }, [hydrated]);

  if (!hydrated) return null;

  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  const navTheme = {
    ...base,
    colors: {
      ...base.colors,
      primary: colors.primary,
      background: colors.background,
      card: colors.background,
      text: colors.foreground,
      border: colors.border,
    },
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <GluestackUIProvider mode={appearance}>
        <ThemeProvider value={navTheme}>
          <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: colors.background },
              headerTintColor: colors.foreground,
              headerShadowVisible: false,
              headerTitleStyle: { fontWeight: '600' },
              contentStyle: { backgroundColor: colors.background },
              animation: 'slide_from_right',
            }}
          >
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="scan" options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade' }} />
            <Stack.Screen name="pair" options={{ title: 'Pair a laptop', presentation: 'modal' }} />
            <Stack.Screen name="link" options={{ title: 'Pairing', presentation: 'modal' }} />
            <Stack.Screen name="open" options={{ headerShown: false }} />
            <Stack.Screen name="settings" options={{ title: 'Settings' }} />
          </Stack>
        </ThemeProvider>
      </GluestackUIProvider>
    </GestureHandlerRootView>
  );
}
