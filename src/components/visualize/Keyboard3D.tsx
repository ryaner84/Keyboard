"use client";

import { useEffect, useRef } from "react";
import { KeyboardScene, type StageState } from "./keyboard-scene";

interface Keyboard3DProps extends StageState {
  label: string;
  /** WebGL could not start or lost its context: the caller shows the classic render instead. */
  onError: () => void;
}

// Loaded with next/dynamic (ssr: false) and only once a visitor picks 3D, so
// three.js never weighs on the page for anyone who doesn't.
export default function Keyboard3D({ label, onError, ...state }: Keyboard3DProps) {
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<KeyboardScene | null>(null);
  const failed = useRef(onError);
  failed.current = onError;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let scene: KeyboardScene;
    try {
      scene = new KeyboardScene(el);
    } catch {
      failed.current();
      return;
    }
    stage.current = scene;
    const lost = (e: Event) => {
      e.preventDefault();
      failed.current();
    };
    scene.renderer.domElement.addEventListener("webglcontextlost", lost);
    const observer = new ResizeObserver(() => scene.resize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      scene.renderer.domElement.removeEventListener("webglcontextlost", lost);
      scene.dispose();
      stage.current = null;
    };
  }, []);

  const { layout, options, colors, placement, profile, caseHex, caseName, view } = state;
  const optionsKey = JSON.stringify(options ?? {});
  const colorsKey = JSON.stringify(colors);
  const placementKey = JSON.stringify(placement ?? {});
  useEffect(() => {
    const scene = stage.current;
    if (!scene) return;
    // Sizing is the ResizeObserver's: it fires once on observe, and again
    // whenever the stage changes width. Re-framing here would also throw away
    // the angle someone turned the board to every time they changed colours.
    scene.update({
      layout,
      options: JSON.parse(optionsKey),
      colors: JSON.parse(colorsKey),
      placement: JSON.parse(placementKey),
      profile,
      caseHex,
      caseName,
      view,
    });
  }, [layout, optionsKey, colorsKey, placementKey, profile, caseHex, caseName, view]);

  return <div ref={host} role="img" aria-label={label} className="w-full aspect-[2/1] cursor-grab active:cursor-grabbing" />;
}
