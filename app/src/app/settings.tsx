import Constants from 'expo-constants';
import { Laptop as LaptopIcon } from 'lucide-react-native';
import { useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';

import { AppearanceSheet } from '@/components/sheets';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Icon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { cache } from '@/lib/cache';
import { unpair } from '@/lib/pairing';
import { timeAgo } from '@/lib/paths';
import { type Appearance, useStore } from '@/lib/store';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <VStack space="sm" className="pt-6">
      <Text size="sm" className="px-1 font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </Text>
      <View className="overflow-hidden rounded-2xl border border-border bg-card">{children}</View>
    </VStack>
  );
}

const APPEARANCES: { id: Appearance; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

export default function Settings() {
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const laptops = Object.values(useStore((s) => s.laptops));
  const [sheet, setSheet] = useState(false);
  const [cacheSize, setCacheSize] = useState(() => cache.sizeLabel());

  const forget = (serverId: string, name: string) =>
    Alert.alert(
      `Forget ${name}?`,
      'This phone won’t connect to it any more and its saved copies are deleted. To remove the phone on the laptop too, run `mdshare unpair`.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Forget', style: 'destructive', onPress: () => void unpair(serverId) },
      ],
    );

  return (
    <ScrollView contentContainerClassName="px-4 pb-12">
      <Section title="App appearance">
        <HStack space="sm" className="p-3">
          {APPEARANCES.map((a) => (
            <Pressable
              key={a.id}
              onPress={() => setPrefs({ appearance: a.id })}
              className={`flex-1 items-center rounded-xl border py-2.5 ${prefs.appearance === a.id ? 'border-primary bg-accent' : 'border-border'}`}
            >
              <Text size="sm" className={prefs.appearance === a.id ? 'font-semibold text-accent-foreground' : ''}>
                {a.label}
              </Text>
            </Pressable>
          ))}
        </HStack>
        <Pressable onPress={() => setSheet(true)} className="border-t border-border p-4 data-[active=true]:bg-muted">
          <Text>Reading settings</Text>
          <Text size="sm" className="text-muted-foreground">
            {`${prefs.font === 'serif' ? 'Serif' : 'Sans'}, ${prefs.fontSize}px, ${prefs.readerTheme} theme`}
          </Text>
        </Pressable>
      </Section>

      <Section title="Paired laptops">
        {laptops.length === 0 ? (
          <Text className="p-4 text-muted-foreground">No laptops paired yet.</Text>
        ) : (
          laptops.map((l, i) => (
            <HStack key={l.serverId} space="md" className={`items-center p-4 ${i ? 'border-t border-border' : ''}`}>
              <Icon as={LaptopIcon} className="text-muted-foreground" />
              <VStack className="flex-1">
                <Text className="font-medium">{l.host}</Text>
                <Text size="xs" className="text-muted-foreground">
                  {`Paired ${timeAgo(l.pairedAt / 1000)}${l.lastSeen ? ` · seen ${timeAgo(l.lastSeen / 1000)}` : ''}`}
                </Text>
                <Text size="xs" className="text-muted-foreground" numberOfLines={1}>
                  {l.hosts.join(', ')}
                </Text>
              </VStack>
              <Button variant="outline" size="sm" onPress={() => forget(l.serverId, l.host)}>
                <ButtonText>Forget</ButtonText>
              </Button>
            </HStack>
          ))
        )}
      </Section>

      <Section title="Offline copies">
        <HStack className="items-center p-4">
          <VStack className="flex-1">
            <Text>Saved documents</Text>
            <Text size="sm" className="text-muted-foreground">
              {`${cacheSize} · files you’ve opened stay readable when the laptop is off`}
            </Text>
          </VStack>
          <Button
            variant="outline"
            size="sm"
            onPress={() => {
              cache.clearAll();
              setCacheSize(cache.sizeLabel());
            }}
          >
            <ButtonText>Clear</ButtonText>
          </Button>
        </HStack>
      </Section>

      <Section title="Sharing from a laptop">
        <VStack space="sm" className="p-4">
          <Text size="sm">Install the mdshare command on your laptop, then run it on a file or folder:</Text>
          <Text size="sm" className="rounded-lg bg-muted p-3 font-mono">
            {'mdshare ./docs\nmdshare plan.md --for 4h --keep-awake'}
          </Text>
          <Text size="sm" className="text-muted-foreground">
            On the same Wi-Fi the phone finds it automatically. Away from home, install Tailscale on both devices and the
            app connects over it.
          </Text>
        </VStack>
      </Section>

      <Text size="xs" className="pt-6 text-center text-muted-foreground">
        {`mdshare ${Constants.expoConfig?.version ?? ''}`}
      </Text>

      <AppearanceSheet isOpen={sheet} onClose={() => setSheet(false)} />
    </ScrollView>
  );
}
