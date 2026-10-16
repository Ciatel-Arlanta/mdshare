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
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { type Nearby, useNearby } from '@/lib/discovery';
import { pickFile, pickFolder } from '@/lib/local';
import { stripExtension, basename } from '@/lib/paths';
import { type Reach, useReachability } from '@/lib/reachability';
import { forgetShare } from '@/lib/pairing';
import { forgetSource } from '@/lib/sources';
import { fileSourceId, folderSourceId, laptopSourceId, useStore } from '@/lib/store';
import type { Laptop } from '@/lib/types';

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

interface ShareRowModel {
  key: string;
  sourceId: string;
  title: string;
  subtitle: string;
  online: boolean;
  /** Set for shares that aren't running, so they can be forgotten. */
  onForget?(): void;
}

/** One row per share on each paired laptop, running ones first. */
function shareRows(laptop: Laptop, reach?: Reach): ShareRowModel[] {
  const online = !!reach?.online;
  const via = reach?.via ?? 'Wi-Fi';
  const running = online ? (reach?.shares ?? []) : [];
  const known = Object.values(laptop.shares ?? {});
  if (!running.length && !known.length) {
    // A laptop on an older mdshare, or not seen since pairing.
    const shareName = reach?.shareName ?? laptop.shareName;
    return [
      {
        key: laptop.serverId,
        sourceId: laptopSourceId(laptop.serverId),
        title: online && shareName ? shareName : laptop.host,
        subtitle: online
          ? `Sharing from ${laptop.host} · ${via}`
          : shareName
            ? `Not sharing · saved copy of “${shareName}”`
            : 'Not sharing right now',
        online,
      },
    ];
  }
  const stopped = known
    .filter((k) => !running.some((r) => r.share_id === k.id))
    .sort((a, b) => b.lastSeen - a.lastSeen);
  return [
    ...running.map((r) => ({
      key: `${laptop.serverId}~${r.share_id}`,
      sourceId: laptopSourceId(laptop.serverId, r.share_id),
      title: r.name,
      subtitle: `Sharing from ${laptop.host} · ${via}`,
      online: true,
    })),
    ...stopped.map((k) => ({
      key: `${laptop.serverId}~${k.id}`,
      sourceId: laptopSourceId(laptop.serverId, k.id),
      title: k.name,
      subtitle: `Not sharing · saved copy from ${laptop.host}`,
      online: false,
      onForget: () =>
        Alert.alert(`Forget “${k.name}”?`, 'Its saved copies on this phone are deleted. The laptop stays paired.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Forget', style: 'destructive', onPress: () => forgetShare(laptop.serverId, k.id) },
        ]),
    })),
  ];
}

function ShareRow({ row }: { row: ShareRowModel }) {
  return (
    <Pressable
      onPress={() => openSource(row.sourceId)}
      onLongPress={row.onForget}
      className="rounded-2xl border border-border bg-card p-4 data-[active=true]:bg-muted"
    >
      <HStack space="md" className="items-center">
        <View className="h-11 w-11 items-center justify-center rounded-xl bg-accent">
          <Icon as={LaptopIcon} size="lg" className="text-accent-foreground" />
        </View>
        <VStack className="flex-1">
          <Text className="font-semibold" numberOfLines={1}>
            {row.title}
          </Text>
          <HStack space="xs" className="items-center">
            <StatusDot on={row.online} />
            <Text size="sm" className="text-muted-foreground" numberOfLines={1}>
              {row.subtitle}
            </Text>
          </HStack>
        </VStack>
        <Icon as={ChevronRight} className="text-muted-foreground" />
      </HStack>
    </Pressable>
  );
}

/** An unpaired laptop on the Wi-Fi, with every share it's running. */
function NearbyRow({ shares }: { shares: Nearby[] }) {
  const n = shares[0];
  const names = shares.map((s) => s.shareName).join(', ');
  return (
    <Pressable
      onPress={() =>
        router.push({
          pathname: '/pair',
          params: { serverId: n.serverId, name: n.host, share: names, hosts: n.addresses.join(','), port: String(n.port) },
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
            {names}
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
  const nearby = useNearby((s) => s.byId);
  const reach = useReachability();

  const paired = Object.values(laptops).sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  const unpairedNearby = Object.values(
    Object.values(nearby)
      .filter((n) => !laptops[n.serverId])
      .reduce<Record<string, Nearby[]>>((acc, n) => ({ ...acc, [n.serverId]: [...(acc[n.serverId] ?? []), n] }), {}),
  );
  const localFolders = Object.values(folders).sort((a, b) => b.addedAt - a.addedAt);
  const localFiles = Object.values(files).sort((a, b) => b.addedAt - a.addedAt).slice(0, 5);

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

        <SectionTitle>Laptops</SectionTitle>
        <VStack space="sm">
          {paired.flatMap((l) => shareRows(l, reach[l.serverId])).map((row) => (
            <ShareRow key={row.key} row={row} />
          ))}
          {unpairedNearby.map((shares) => (
            <NearbyRow key={shares[0].serverId} shares={shares} />
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
