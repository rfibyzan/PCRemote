/** Pure: weight -> family of a {regular, medium, bold} set (null = system). */
export function pickFamily(set, weight) {
  if (!set) return null;
  const w = weight === "bold" ? 700 : weight === "normal" || weight == null ? 400 : parseInt(weight, 10) || 400;
  if (w >= 700) return set.bold;
  if (w >= 500) return set.medium;
  return set.regular;
}
