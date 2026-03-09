export function hapticFeedback(type: 'light' | 'medium' | 'heavy' = 'light'): void {
  if (!navigator.vibrate) return;
  const durations: Record<string, number> = {
    light: 10,
    medium: 25,
    heavy: 50,
  };
  navigator.vibrate(durations[type] ?? 10);
}
