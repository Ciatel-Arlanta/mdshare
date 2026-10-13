import { Minus, Plus } from 'lucide-react-native';
import { View } from 'react-native';

import {
  Actionsheet,
  ActionsheetBackdrop,
  ActionsheetContent,
  ActionsheetDragIndicator,
  ActionsheetDragIndicatorWrapper,
  ActionsheetScrollView,
} from '@/components/ui/actionsheet';
import { Button, ButtonIcon } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { type ReaderTheme, useStore } from '@/lib/store';
import { READER_BACKGROUND } from '@/lib/theme';

import type { TocItem } from './reader-view';

interface SheetProps {
  isOpen: boolean;
  onClose(): void;
}

function Sheet({ isOpen, onClose, children }: SheetProps & { children: React.ReactNode }) {
  return (
    <Actionsheet isOpen={isOpen} onClose={onClose} snapPoints={[70]}>
      <ActionsheetBackdrop />
      <ActionsheetContent className="items-stretch">
        <ActionsheetDragIndicatorWrapper>
          <ActionsheetDragIndicator />
        </ActionsheetDragIndicatorWrapper>
        {children}
      </ActionsheetContent>
    </Actionsheet>
  );
}

export function TocSheet({ isOpen, onClose, items, onPick }: SheetProps & { items: TocItem[]; onPick(id: string): void }) {
  const minLevel = Math.min(...items.map((i) => i.level), 6);
  return (
    <Sheet isOpen={isOpen} onClose={onClose}>
      <Heading size="sm" className="px-3 pb-2 pt-1">
        Contents
      </Heading>
      <ActionsheetScrollView>
        {items.length === 0 ? (
          <Text className="px-3 py-6 text-muted-foreground">This document has no headings.</Text>
        ) : (
          items.map((item, i) => (
            <Pressable
              key={`${item.id}-${i}`}
              onPress={() => {
                onClose();
                onPick(item.id);
              }}
              className="rounded-lg py-2.5 data-[active=true]:bg-muted"
              style={{ paddingLeft: 12 + (item.level - minLevel) * 16, paddingRight: 12 }}
            >
              <Text
                numberOfLines={2}
                className={item.level === minLevel ? 'font-semibold' : 'text-muted-foreground'}
              >
                {item.text}
              </Text>
            </Pressable>
          ))
        )}
        <View className="h-6" />
      </ActionsheetScrollView>
    </Sheet>
  );
}

const THEMES: { id: ReaderTheme; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'light', label: 'Light' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'dark', label: 'Dark' },
  { id: 'black', label: 'Black' },
];

const WIDTHS = [
  { value: 56, label: 'Narrow' },
  { value: 68, label: 'Medium' },
  { value: 84, label: 'Wide' },
  { value: 0, label: 'Full' },
];

const SPACING = [
  { value: 1.45, label: 'Tight' },
  { value: 1.65, label: 'Normal' },
  { value: 1.9, label: 'Loose' },
];

function Chip({ label, selected, onPress, swatch }: { label: string; selected: boolean; onPress(): void; swatch?: string }) {
  return (
    <Pressable
      onPress={onPress}
      className={`flex-1 items-center rounded-xl border px-2 py-2.5 ${selected ? 'border-primary bg-accent' : 'border-border'}`}
    >
      {swatch ? (
        <View className="mb-1.5 h-6 w-6 rounded-full border border-border" style={{ backgroundColor: swatch }} />
      ) : null}
      <Text size="sm" className={selected ? 'font-semibold text-accent-foreground' : ''}>
        {label}
      </Text>
    </Pressable>
  );
}

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <VStack space="sm">
      <Text size="sm" className="font-medium text-muted-foreground">
        {title}
      </Text>
      <HStack space="sm">{children}</HStack>
    </VStack>
  );
}

export function AppearanceSheet({ isOpen, onClose }: SheetProps) {
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const auto = '#dfe3e8';

  return (
    <Sheet isOpen={isOpen} onClose={onClose}>
      <ActionsheetScrollView>
        <VStack space="xl" className="px-3 pb-8 pt-1">
          <Row title="Theme">
            {THEMES.map((t) => (
              <Chip
                key={t.id}
                label={t.label}
                selected={prefs.readerTheme === t.id}
                swatch={t.id === 'auto' ? auto : READER_BACKGROUND[t.id]}
                onPress={() => setPrefs({ readerTheme: t.id })}
              />
            ))}
          </Row>

          <VStack space="sm">
            <Text size="sm" className="font-medium text-muted-foreground">
              Text size
            </Text>
            <HStack space="md" className="items-center">
              <Button
                variant="outline"
                size="icon"
                className="h-11 w-11 rounded-full"
                isDisabled={prefs.fontSize <= 13}
                onPress={() => setPrefs({ fontSize: prefs.fontSize - 1 })}
              >
                <ButtonIcon as={Minus} />
              </Button>
              <Text className="flex-1 text-center" size="lg">
                {prefs.fontSize}
              </Text>
              <Button
                variant="outline"
                size="icon"
                className="h-11 w-11 rounded-full"
                isDisabled={prefs.fontSize >= 30}
                onPress={() => setPrefs({ fontSize: prefs.fontSize + 1 })}
              >
                <ButtonIcon as={Plus} />
              </Button>
            </HStack>
          </VStack>

          <Row title="Font">
            <Chip label="Serif" selected={prefs.font === 'serif'} onPress={() => setPrefs({ font: 'serif' })} />
            <Chip label="Sans" selected={prefs.font === 'sans'} onPress={() => setPrefs({ font: 'sans' })} />
          </Row>

          <Row title="Line width">
            {WIDTHS.map((w) => (
              <Chip key={w.value} label={w.label} selected={prefs.width === w.value} onPress={() => setPrefs({ width: w.value })} />
            ))}
          </Row>

          <Row title="Line spacing">
            {SPACING.map((s) => (
              <Chip
                key={s.value}
                label={s.label}
                selected={Math.abs(prefs.lineHeight - s.value) < 0.01}
                onPress={() => setPrefs({ lineHeight: s.value })}
              />
            ))}
          </Row>

          <HStack className="items-center justify-between">
            <VStack className="flex-1 pr-4">
              <Text>Keep screen on</Text>
              <Text size="sm" className="text-muted-foreground">
                While a document is open
              </Text>
            </VStack>
            <Switch value={prefs.keepScreenOn} onValueChange={(v) => setPrefs({ keepScreenOn: v })} />
          </HStack>
        </VStack>
      </ActionsheetScrollView>
    </Sheet>
  );
}
