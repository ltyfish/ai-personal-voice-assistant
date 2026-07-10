"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { Float, Sparkles } from "@react-three/drei";
import * as THREE from "three";
import { useEffect, useMemo, useRef, useState } from "react";
import { getOrbState, subscribeOrbState } from "@/lib/orb-state";
import type { OrbState } from "@/components/jarvis/SwirlOrb";

const stateColors: Record<OrbState, string> = {
  "st-standby": "#b5a7df",
  "st-listening": "#7ebce8",
  "st-recording": "#eb8fa6",
  "st-thinking": "#b893ee",
  "st-confirming": "#e5b982",
};

const vertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = `
  uniform float uTime;
  uniform vec2 uMouse;
  uniform vec3 uAccent;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453123); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.,0.)), f.x),
               mix(hash(i + vec2(0.,1.)), hash(i + vec2(1.,1.)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
    return v;
  }
  void main() {
    vec2 uv = vUv;
    vec2 p = (uv - .5) * vec2(1.8, 1.0);
    float d = length(p - uMouse * .09);
    float warp = fbm(p * 2.1 + fbm(p * 1.3 + uTime * .025));
    vec3 pearl = vec3(.87, .86, .91);
    vec3 fog = vec3(.30, .29, .38);
    vec3 color = mix(fog, pearl, smoothstep(.04, 1.1, warp + .12));
    color = mix(color, uAccent, .14 + .12 * sin(warp * 5. + uTime * .08));
    color += exp(-d * 3.2) * uAccent * .12;
    float vignette = smoothstep(1.18, .2, length(p));
    gl_FragColor = vec4(color * (.78 + .3 * vignette), .76);
  }
`;

function LivingScene({ state, reduced }: { state: OrbState; reduced: boolean }) {
  const group = useRef<THREE.Group>(null);
  const surface = useRef<THREE.ShaderMaterial>(null);
  const targetMouse = useRef(new THREE.Vector2());
  const smoothMouse = useRef(new THREE.Vector2());
  const accent = useMemo(() => new THREE.Color(stateColors[state]), [state]);
  const uniforms = useMemo(() => ({
    uTime: { value: 0 },
    uMouse: { value: new THREE.Vector2() },
    uAccent: { value: accent.clone() },
  }), []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      targetMouse.current.set(event.clientX / innerWidth - .5, -(event.clientY / innerHeight - .5));
    };
    if (!reduced) window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [reduced]);

  useFrame((_, delta) => {
    if (surface.current) {
      if (!reduced) surface.current.uniforms.uTime.value += delta;
      smoothMouse.current.lerp(targetMouse.current, .045);
      surface.current.uniforms.uMouse.value.copy(smoothMouse.current);
      surface.current.uniforms.uAccent.value.lerp(accent, .035);
    }
    if (group.current && !reduced) {
      group.current.rotation.y = THREE.MathUtils.damp(group.current.rotation.y, smoothMouse.current.x * .45, 4, delta);
      group.current.rotation.x = THREE.MathUtils.damp(group.current.rotation.x, smoothMouse.current.y * .28, 4, delta);
    }
  });

  const energy = state === "st-recording" ? 1.18 : state === "st-thinking" ? 1.08 : 1;

  return (
    <>
      <mesh position={[0, 0, -2.5]} scale={[12, 7, 1]}>
        <planeGeometry args={[1, 1, 1, 1]} />
        <shaderMaterial ref={surface} vertexShader={vertexShader} fragmentShader={fragmentShader} uniforms={uniforms} depthWrite={false} transparent />
      </mesh>
      <group ref={group} position={[1.08, .06, .35]} scale={energy * 1.18}>
        <Float speed={reduced ? 0 : 1.15} rotationIntensity={reduced ? 0 : .22} floatIntensity={reduced ? 0 : .22}>
          <mesh>
            <icosahedronGeometry args={[1.05, 5]} />
            <meshPhysicalMaterial
              color={stateColors[state]}
              emissive={stateColors[state]}
              emissiveIntensity={.5}
              metalness={.32}
              roughness={.12}
              transmission={.22}
              thickness={1.8}
              clearcoat={1}
              clearcoatRoughness={.1}
              transparent
              opacity={.94}
            />
          </mesh>
          <mesh scale={1.08}>
            <icosahedronGeometry args={[1.05, 2]} />
            <meshBasicMaterial color={stateColors[state]} wireframe transparent opacity={.18} />
          </mesh>
          <pointLight color={stateColors[state]} intensity={3.2} distance={7} />
        </Float>
        <Sparkles count={reduced ? 24 : 90} scale={[4.6, 3.2, 2.5]} size={2.2} speed={reduced ? 0 : .16} color={stateColors[state]} opacity={.58} />
      </group>
      <ambientLight intensity={1.1} />
      <directionalLight position={[-4, 5, 6]} intensity={2.4} color="#fff9f0" />
    </>
  );
}

export default function JarvisWorld() {
  const [state, setState] = useState<OrbState>(getOrbState());
  const [reduced, setReduced] = useState(false);

  useEffect(() => subscribeOrbState(setState), []);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce), (prefers-reduced-data: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return (
    <div className="jarvis-world" role="img" aria-label="A luminous responsive AI orb in a pearl and lavender spatial environment">
      <div className="jarvis-world-poster" />
      <Canvas dpr={[1, 1.6]} camera={{ position: [0, 0, 5], fov: 42 }} gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}>
        <LivingScene state={state} reduced={reduced} />
      </Canvas>
    </div>
  );
}
