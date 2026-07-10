"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

const JarvisWorld = dynamic(() => import("./JarvisWorld"), { ssr: false });

export default function ExperienceLayer() {
  const cursor = useRef<HTMLDivElement>(null);
  const cursorLabel = useRef<HTMLSpanElement>(null);
  const [finePointer, setFinePointer] = useState(false);

  useEffect(() => {
    gsap.registerPlugin(ScrollTrigger);
    gsap.defaults({ ease: "expo.out" });
    const lenis = new Lenis({ lerp: .09, smoothWheel: true });
    const tick = (time: number) => lenis.raf(time * 1000);
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    return () => {
      gsap.ticker.remove(tick);
      lenis.destroy();
    };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)");
    setFinePointer(mq.matches);
    if (!mq.matches || !cursor.current) return;
    const node = cursor.current;
    let tx = innerWidth / 2, ty = innerHeight / 2, x = tx, y = ty, raf = 0;
    const move = (event: PointerEvent) => { tx = event.clientX; ty = event.clientY; };
    const over = (event: PointerEvent) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("button, a, input, select, [data-cursor]");
      const label = target?.dataset.cursor || (target?.matches("input, select") ? "TYPE" : target ? "OPEN" : "");
      node.classList.toggle("is-active", !!target);
      if (cursorLabel.current) cursorLabel.current.textContent = label;
    };
    const frame = () => {
      x += (tx - x) * .16; y += (ty - y) * .16;
      node.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      raf = requestAnimationFrame(frame);
    };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerover", over, { passive: true });
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerover", over);
    };
  }, [finePointer]);

  return (
    <>
      <JarvisWorld />
      <div className="experience-grade" aria-hidden />
      {finePointer && <div className="experience-cursor" ref={cursor} aria-hidden><span ref={cursorLabel} /></div>}
    </>
  );
}
