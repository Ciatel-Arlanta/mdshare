import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { X } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, ButtonIcon, ButtonText } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { parsePairLink } from '@/lib/net';

export default function Scan() {
  const [permission, requestPermission] = useCameraPermissions();
  const [hint, setHint] = useState('Point the camera at the QR code in your laptop’s terminal');
  const handled = useRef(false);

  if (!permission) return <View className="flex-1 bg-black" />;

  if (!permission.granted) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <VStack space="lg" className="flex-1 justify-center p-8">
          <Heading size="xl">Camera access</Heading>
          <Text className="text-muted-foreground">
            The camera is only used to read the pairing QR code. You can also pair by typing the 6-digit code instead.
          </Text>
          <Button className="h-12 rounded-xl" onPress={requestPermission}>
            <ButtonText>Allow camera</ButtonText>
          </Button>
          <Button variant="outline" className="h-12 rounded-xl" onPress={() => router.replace('/pair')}>
            <ButtonText>Enter code instead</ButtonText>
          </Button>
          <Button variant="ghost" onPress={() => router.back()}>
            <ButtonText>Cancel</ButtonText>
          </Button>
        </VStack>
      </SafeAreaView>
    );
  }

  return (
    <View className="flex-1 bg-black">
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (handled.current) return;
          if (!parsePairLink(data)) {
            setHint('That’s not an mdshare code. Scan the one printed by mdshare on your laptop.');
            return;
          }
          handled.current = true;
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          router.replace({ pathname: '/link', params: { url: data } });
        }}
      />
      <SafeAreaView style={StyleSheet.absoluteFill} className="justify-between">
        <View className="items-end p-4">
          <Button
            variant="secondary"
            size="icon"
            className="h-11 w-11 rounded-full bg-black/50"
            onPress={() => router.back()}
            accessibilityLabel="Close"
          >
            <ButtonIcon as={X} className="h-6 w-6 text-white" />
          </Button>
        </View>
        <View className="items-center">
          <View className="h-64 w-64 rounded-3xl border-2 border-white/80" />
        </View>
        <View className="items-center p-8">
          <Text className="rounded-full bg-black/60 px-4 py-2 text-center text-white">{hint}</Text>
        </View>
      </SafeAreaView>
    </View>
  );
}
