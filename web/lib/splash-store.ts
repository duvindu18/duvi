import { create } from "zustand";

type SplashState = {
  /** The splash overlay has finished its exit animation. */
  done: boolean;
  finish: () => void;
};

export const useSplash = create<SplashState>((set) => ({
  done: false,
  finish: () => set({ done: true }),
}));
