import { router } from 'expo-router';
import {
  ChevronRight,
  FileText,
  FolderOpen,
  FolderPlus,
  KeyRound,
  Laptop as LaptopIcon,
  QrCode,
  Settings,
  Wifi,
} from 'lucide-react-native';
import { Alert, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, ButtonIcon, ButtonText } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import { Icon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Progress, ProgressFilledTrack } from '@/components/ui/progress';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { type Nearby, useNearby } from '@/lib/discovery';
import { pickFile, pickFolder } from '@/lib/local';
import { stripExtension, basename } from '@/lib/paths';
import { type Reach, useReachability } from '@/lib/reachability';
import { forgetSource } from '@/lib/sources';
import { fileSourceId, folderSourceId, laptopSourceId, useStore } from '@/lib/store';
import type { Laptop, Recent } from '@/lib/types';

function openSource(sourceId: string) {
  router.push({ pathname: '/source/[id]', params: { id: sourceId } });
}

function openDoc(sourceId: string, path: string) {
  router.push({ pathname: '/source/[id]/read', params: { id: sourceId, path } });
}

function SectionTitle({ children, action }: { children: string; action?: React.ReactNode }) {
  return (
    <HStack className="items-center justify-between px-1 pb-2 pt-6">
      <Text size="sm" className="font-semibold uppercase tracking-wider text-muted-foreground">
        {children}
      </Text>
      {action}
    </HStack>
  );
}

function StatusDot({ on }: { on: boolean }) {
  return <View className={`h-2 w-2 rounded-full ${on ? 'bg-success' : 'bg-muted-foreground/40'}`} />;
}

function LaptopRow({ laptop, reach }: { laptop: Laptop; reach?: Reach }) {
  const online = !!reach?.online;
  const shareName = reach?.shareName ?? laptop.shareName;
  return (
    <Pressable
      onPress={() => openSource(laptopSourceId(laptop.serverId))}
      className="rounded-2xl border border-border bg-card p-4 data-[active=true]:bg-muted"
    >
      <HStack space="md" className="items-center">
        <View className="h-11 w-11 items-center justify-center rounded-xl bg-accent">
          <Icon as={LaptopIcon} size="lg" className="text-accent-foreground" />
        </View>
        <VStack className="flex-1">
          <Text className="font-semibold" numberOfLines={1}>
            {online && shareName ? shareName : laptop.host}
          </Text>
          <HStack space="xs" className="items-center">
            <StatusDot on={online} />
            <Text size="sm" className="text-muted-foreground" numberOfLines={1}>
              {online
                ? `Sharing from ${laptop.host} · ${reach?.via ?? 'Wi-Fi'}`
                : shareName
                  ? `Not sharing · saved copy of “${shareName}”`
                  : 'Not sharing right now'}
            </Text>
          </HStack>
        </VStack>
        <Icon as={ChevronRight} className="text-muted-foreground" />
      </HStack>
    </Pressable>
  );
}

function NearbyRow({ n }: { n: Nearby }) {
  return (
    <Pressable
      onPress={() =>
        router.push({
          pathname: '/pair',
          params: { serverId: n.serverId, name: n.host, share: n.shareName, hosts: n.addresses.join(','), port: String(n.port) },
        })
      }
      className="rounded-2xl border border-dashed border-primary/50 p-4 data-[active=true]:bg-accent"
    >
      <HStack space="md" className="items-center">
        <View className="h-11 w-11 items-center justify-center rounded-xl bg-muted">
          <Icon as={Wifi} size="lg" className="text-primary" />
        </View>
        <VStack className="flex-1">
          <Text className="font-semibold" numberOfLines={1}>
            {n.shareName}
          </Text>
          <Text size="sm" className="text-muted-foreground" numberOfLines={1}>
            {`On ${n.host} · tap to pair`}
          </Text>
        </VStack>
        <Text size="sm" className="font-semibold text-primary">
          Pair
        </Text>
      </HStack>
    </Pressable>
  );
}

function RecentCard({ recent, sourceName }: { recent: Recent; sourceName: string }) {
  return (
    <Pressable
      onPress={() => openDoc(recent.sourceId, recent.path)}
      className="mr-3 w-56 rounded-2xl border border-border bg-card p-4 data-[active=true]:bg-muted"
    >
      <VStack space="xs" className="flex-1">
        <Icon as={FileText} className="mb-1 text-primary" />
        <Text className="font-semibold" numberOfLines={2}>
          {recent.title}
        </Text>
        <Text size="sm" className="text-muted-foreground" numberOfLines={1}>
          {sourceName}
        </Text>
      </VStack>
      <Progress value={Math.round(recent.progress * 100)} className="mt-3 h-1 bg-muted">
        <ProgressFilledTrack className="h-1 bg-primary" />
      </Progress>
    </Pressable>
  );
}

function LocalRow({
  icon,
  title,
  subtitle,
  onPress,
  onLongPress,
}: {
  icon: typeof FolderOpen;
  title: string;
  subtitle: string;
  onPress(): void;
  onLongPress(): void;
}) {
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} className="rounded-xl px-2 py-3 data-[active=true]:bg-muted">
      <HStack space="md" className="items-center">
        <Icon as={icon} size="lg" className="text-muted-foreground" />
        <VStack className="flex-1">
          <Text numberOfLines={1}>{title}</Text>
          <Text size="xs" className="text-muted-foreground">
            {subtitle}
          </Text>
        </VStack>
      </HStack>
    </Pressable>
  );
}

export default function Home() {
  const laptops = useStore((s) => s.laptops);
  const folders = useStore((s) => s.folders);
  const files = useStore((s) => s.files);
  const recents = useStore((s) => s.recents);
  const nearby = useNearby((s) => s.byId);
  const reach = useReachability();

  const paired = Object.values(laptops).sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  const unpairedNearby = Object.values(nearby).filter((n) => !laptops[n.serverId]);
  const localFolders = Object.values(folders).sort((a, b) => b.addedAt - a.addedAt);
  const localFiles = Object.values(files).sort((a, b) => b.addedAt - a.addedAt).slice(0, 5);

  const sourceName = (id: string) => {
    const key = id.slice(2);
    if (id.startsWith('l-')) return laptops[key]?.shareName ?? laptops[key]?.host ?? 'Laptop';
    if (id.startsWith('f-')) return folders[key]?.name ?? 'Folder';
    return 'On this phone';
  };
  const liveRecents = recents
    .filter((r) => {
      const key = r.sourceId.slice(2);
      return r.sourceId.startsWith('l-') ? laptops[key] : r.sourceId.startsWith('f-') ? folders[key] : files[key];
    })
    .slice(0, 8);

  const removeLocal = (kind: 'folder' | 'file', id: string, name: string) =>
    Alert.alert(`Remove “${name}”?`, 'It stays on your phone; it just leaves this list.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          if (kind === 'folder') {
            forgetSource(folderSourceId(id));
            useStore.getState().removeFolder(id);
          } else {
            forgetSource(fileSourceId(id));
            useStore.getState().removeFile(id);
          }
        },
      },
    ]);

  const onOpenFolder = async () => {
    const id = await pickFolder();
    if (id) openSource(id);
  };
  const onOpenFile = async () => {
    const res = await pickFile();
    if (res) openDoc(res.sourceId, res.name);
  };

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <ScrollView contentContainerClassName="w-full max-w-3xl self-center px-4 pb-12">
        <HStack className="items-center justify-between pb-2 pt-4">
          <VStack>
            <Heading size="2xl">mdshare</Heading>
            <Text size="sm" className="text-muted-foreground">
              Markdown from your laptop, on your phone
            </Text>
          </VStack>
          <Button variant="ghost" size="icon" className="h-11 w-11 rounded-full" onPress={() => router.push('/settings')}>
            <ButtonIcon as={Settings} className="h-6 w-6" />
          </Button>
        </HStack>

        {liveRecents.length > 0 && (
          <>
            <SectionTitle>Continue reading</SectionTitle>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} className="-mx-4" contentContainerClassName="px-4">
              {liveRecents.map((r) => (
                <RecentCard key={`${r.sourceId}:${r.path}`} recent={r} sourceName={sourceName(r.sourceId)} />
              ))}
            </ScrollView>
          </>
        )}

        <SectionTitle>Laptops</SectionTitle>
        <VStack space="sm">
          {paired.map((l) => (
            <LaptopRow key={l.serverId} laptop={l} reach={reach[l.serverId]} />
          ))}
          {unpairedNearby.map((n) => (
            <NearbyRow key={n.serverId} n={n} />
          ))}
          {paired.length === 0 && unpairedNearby.length === 0 && (
            <View className="rounded-2xl border border-border bg-card p-5">
              <Text className="font-semibold">Pair your laptop</Text>
              <Text size="sm" className="mt-1 text-muted-foreground">
                On the laptop, run <Text size="sm" className="font-mono text-foreground">mdshare your-folder</Text>,
                then scan the QR code it prints. You only do this once; after that the app finds the laptop by
                itself on Wi-Fi or Tailscale.
              </Text>
            </View>
          )}
          <HStack space="sm" className="pt-1">
            <Button className="h-12 flex-1 rounded-xl" onPress={() => router.push('/scan')}>
              <ButtonIcon as={QrCode} />
              <ButtonText>Scan QR code</ButtonText>
            </Button>
            <Button variant="outline" className="h-12 flex-1 rounded-xl" onPress={() => router.push('/pair')}>
              <ButtonIcon as={KeyRound} />
              <ButtonText>Enter code</ButtonText>
            </Button>
          </HStack>
        </VStack>

        <SectionTitle>On this phone</SectionTitle>
        <VStack>
          {localFolders.map((f) => (
            <LocalRow
              key={f.id}
              icon={FolderOpen}
              title={f.name}
              subtitle="Folder"
              onPress={() => openSource(folderSourceId(f.id))}
              onLongPress={() => removeLocal('folder', f.id, f.name)}
            />
          ))}
          {localFiles.map((f) => (
            <LocalRow
              key={f.id}
              icon={FileText}
              title={stripExtension(basename(f.name))}
              subtitle="File"
              onPress={() => openDoc(fileSourceId(f.id), f.name)}
              onLongPress={() => removeLocal('file', f.id, f.name)}
            />
          ))}
          <HStack space="sm" className="pt-2">
            <Button variant="outline" className="h-12 flex-1 rounded-xl" onPress={onOpenFolder}>
              <ButtonIcon as={FolderPlus} />
              <ButtonText>Open folder</ButtonText>
            </Button>
            <Button variant="outline" className="h-12 flex-1 rounded-xl" onPress={onOpenFile}>
              <ButtonIcon as={FileText} />
              <ButtonText>Open file</ButtonText>
            </Button>
          </HStack>
        </VStack>
      </ScrollView>
    </SafeAreaView>
  );
}
