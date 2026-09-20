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
  }
}

export {};
