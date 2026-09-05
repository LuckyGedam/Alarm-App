// Ambiguous characters (0/O, 1/I/L) are excluded so codes are easy to read aloud.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** Generate a short, human-friendly join code (default 6 chars). */
export function makeJoinCode(length = 6) {
  const values = new Uint32Array(length)
  crypto.getRandomValues(values)
  return Array.from(values, (n) => CODE_CHARS[n % CODE_CHARS.length]).join('')
}

/** Initials for the avatar circle, from a display name or email. */
export function initialsOf(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return parts
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('')
}

const AVATAR_COLORS = ['#aa3bff', '#4f46e5', '#06b6d4', '#059669', '#d97706', '#db2777']

/** Deterministic gradient for a member's avatar based on their name. */
export function avatarGradient(name = '') {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) | 0
  const a = AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
  const b = AVATAR_COLORS[(Math.abs(hash) + 3) % AVATAR_COLORS.length]
  return `linear-gradient(135deg, ${a}, ${b})`
}