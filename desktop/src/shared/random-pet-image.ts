export function selectRandomPetImage(
  pool: readonly string[],
  previous: string | undefined,
  excluded: ReadonlySet<string>,
  random: () => number = Math.random,
): string | undefined {
  const usable = pool.filter((image) => !excluded.has(image));
  if (!usable.length) return undefined;
  const candidates = usable.length > 1
    ? usable.filter((image) => image !== previous)
    : usable;
  const bounded = Math.min(Math.max(random(), 0), 0.999999999);
  return candidates[Math.floor(bounded * candidates.length)];
}
