import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, ButtonText } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { parsePairLink } from '@/lib/net';
import { pairWithSecret } from '@/lib/pairing';

/** Pairs from a scanned QR code (also reached via the mdshare:// link). */
export default function Link() {
  const { url } = useLocalSearchParams<{ url: string }>();
  const link = parsePairLink(url ?? '');
  const [failure, setError] = useState('');
  const error = link ? failure : 'This isn’t a valid mdshare pairing code.';

  const run = useCallback((): Promise<void> => {
    if (!link) return Promise.resolve();
    return pairWithSecret(link.hosts, link.port, link.serverId, link.secret).then(
      (sourceId) => {
        router.dismissAll();
        router.push({ pathname: '/source/[id]', params: { id: sourceId } });
      },
      (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setError(
          /reach/i.test(msg)
            ? 'Couldn’t reach the laptop. Make sure the phone is on the same Wi-Fi (or Tailscale) and mdshare is still running.'
            : msg,
        );
      },
    );
  }, [link?.serverId, link?.secret]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void run();
  }, [run]);

  return (
    <View className="flex-1 items-center justify-center bg-background p-8">
      {error ? (
        <VStack space="lg" className="w-full max-w-sm">
          <Heading size="lg">Couldn’t pair</Heading>
          <Text className="text-muted-foreground">{error}</Text>
          <Button
            className="h-12 rounded-xl"
            onPress={() => {
              setError('');
              void run();
            }}
          >
            <ButtonText>Try again</ButtonText>
          </Button>
          <Button variant="outline" className="h-12 rounded-xl" onPress={() => router.replace('/pair')}>
            <ButtonText>Enter code instead</ButtonText>
          </Button>
        </VStack>
      ) : (
        <VStack space="md" className="items-center">
          <Spinner size="large" />
          <Text className="text-muted-foreground">Pairing with your laptop…</Text>
        </VStack>
      )}
    </View>
  );
}
