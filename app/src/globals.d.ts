import type {CycIconName} from './components/iconGlyphs';

declare module '*.svg' {
  const url: string;
  export default url;
}

declare global {
  type Icon = CycIconName;

  interface Window {
    Prism?: {
      manual?: boolean;
    };
    // Set by the boot watchdog inline script in index.html; called by main the
    // moment it starts so the watchdog does not beacon a false stuck-boot.
    __cycBootOk?: () => void;
  }
}

export {};
