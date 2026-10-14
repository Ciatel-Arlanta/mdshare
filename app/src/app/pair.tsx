import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView } from 'react-native';

import { Button, ButtonSpinner, ButtonText } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Input, InputField } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type { Candidate } from '@/lib/net';
import { pairWithCode } from '@/lib/pairing';

const DEFAULT_PORT = 7878;

/** "192.168.1.5", "192.168.1.5:7879", "laptop.tail123.ts.net" or "[fd7a::1]:7878". */
function parseAddress(text: string): Candidate | null {
  const t = text.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!t) return null;
  const v6 = /^\[([0-9a-f:.]+)\](?::(\d+))?$/i.exec(t);
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : DEFAULT_PORT };
  // A bare IPv6 address has several colons and no port.
  if ((t.match(/:/g) ?? []).length > 1) return { host: t, port: DEFAULT_PORT };
  const m = /^(.+?)(?::(\d+))?$/.exec(t);
  if (!m) return null;
  return { host: m[1], port: m[2] ? Number(m[2]) : DEFAULT_PORT };
}

export default function Pair() {
  const params = useLocalSearchParams<{ serverId?: string; name?: string; share?: string; hosts?: string; port?: string }>();
  const discovered = !!params.hosts;
  const [code, setCode] = useState('');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const digits = code.replace(/\D/g, '');

  const submit = async (value = digits) => {
    if (value.length !== 6 || busy) return;
    let candidates: Candidate[];
    if (discovered) {
      const port = Number(params.port) || DEFAULT_PORT;
      candidates = params.hosts!.split(',').map((host) => ({ host, port }));
    } else {
      const parsed = parseAddress(address);
      if (!parsed) {
        setError('Enter the laptop’s address, shown next to “Wi-Fi/LAN” in the terminal.');
        return;
      }
      candidates = [parsed];
    }
    setBusy(true);
    setError('');
    try {
      const sourceId = await pairWithCode(candidates, value, params.serverId);
      router.dismissAll();
      router.push({ pathname: '/source/[id]', params: { id: sourceId } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView className="flex-1 bg-background" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerClassName="p-6" keyboardShouldPersistTaps="handled">
        <VStack space="xl">
          <VStack space="sm">
            <Heading size="xl">{discovered ? `Pair with ${params.name}` : 'Pair with a code'}</Heading>
            <Text className="text-muted-foreground">
              {discovered
                ? `Type the pair code shown in the terminal where “${params.share}” is being shared.`
                : 'Type the laptop’s address and the pair code, both shown in the terminal after you run mdshare.'}
            </Text>
          </VStack>

          {!discovered && (
            <VStack space="xs">
              <Text size="sm" className="font-medium">
                Laptop address
              </Text>
              <Input className="h-12 rounded-xl">
                <InputField
                  value={address}
                  onChangeText={setAddress}
                  placeholder="192.168.1.20:7878"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  returnKeyType="next"
                />
              </Input>
            </VStack>
          )}

          <VStack space="xs">
            <Text size="sm" className="font-medium">
              Pair code
            </Text>
            <Input className="h-16 rounded-xl">
              <InputField
                value={code}
                onChangeText={(t) => {
                  const d = t.replace(/\D/g, '').slice(0, 6);
                  setCode(d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d);
                  if (d.length === 6 && discovered) void submit(d);
                }}
                placeholder="123 456"
                keyboardType="number-pad"
                autoFocus={discovered}
                maxLength={7}
                // Not `text-center`: react-native-css 3.0 crashes mapping
                // textAlign on TextInput, so use the native prop.
                textAlign="center"
                className="text-3xl"
                style={{ letterSpacing: 6 }}
                onSubmitEditing={() => void submit()}
              />
            </Input>
          </VStack>

          {error ? <Text className="text-destructive">{error}</Text> : null}

          <Button className="h-12 rounded-xl" isDisabled={digits.length !== 6 || busy} onPress={() => void submit()}>
            {busy ? <ButtonSpinner /> : null}
            <ButtonText>{busy ? 'Pairing…' : 'Pair'}</ButtonText>
          </Button>

          <Text size="sm" className="text-muted-foreground">
            You only pair once. After that this phone connects to the laptop by itself whenever it’s sharing.
          </Text>
        </VStack>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
