//! Keeping the laptop awake while a share is running.

/// Holds a "system required" request until dropped.
pub struct KeepAwake(());

impl KeepAwake {
    /// Returns `None` if the platform doesn't support it.
    pub fn start() -> Option<Self> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Power::{
                ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
            };
            // SAFETY: plain Win32 call with constant flags.
            let prev = unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
            (prev != 0).then_some(Self(()))
        }
        #[cfg(not(windows))]
        {
            None
        }
    }
}

impl Drop for KeepAwake {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Power::{ES_CONTINUOUS, SetThreadExecutionState};
            // SAFETY: see above; clears the request made in `start`.
            unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        }
    }
}
