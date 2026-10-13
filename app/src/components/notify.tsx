import { useCallback } from 'react';

import { Toast, ToastDescription, useToast } from '@/components/ui/toast';

/** Short, single-line feedback, e.g. "Copied" or "Couldn't open that link". */
export function useNotify() {
  const toast = useToast();
  return useCallback(
    (message: string) => {
      toast.show({
        placement: 'bottom',
        duration: 2500,
        render: ({ id }) => (
          <Toast nativeID={`toast-${id}`} action="muted" variant="solid" className="mb-6 rounded-full px-5 py-3">
            <ToastDescription>{message}</ToastDescription>
          </Toast>
        ),
      });
    },
    [toast],
  );
}
