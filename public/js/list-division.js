// A prévia no navegador e a gravação no servidor usam a mesma distribuição.
export function planDivision(total, mode, value) {
  if (!Number.isSafeInteger(value) || value < 1 || total < 2) return null;
  const count = mode === 'size' ? Math.ceil(total / value) : value;
  if (count < 2 || count > total) return null;
  return {
    count,
    sizeAt(index) {
      if (mode === 'size') return Math.min(value, total - index * value);
      return Math.floor(total / count) + Number(index < total % count);
    },
  };
}

export function partName(base, index, count) {
  const part = String(index + 1).padStart(String(count).length, '0');
  const suffix = ' · Parte ' + part;
  return base.slice(0, 120 - suffix.length).trimEnd() + suffix;
}
