const NAME_KEY = "tt:guestName"
const COLOR_KEY = "tt:guestColor"

const colors = [
  "#958DF1",
  "#F98181",
  "#FBBC88",
  "#FAF594",
  "#70CFF8",
  "#94FADB",
  "#B9F18D",
  "#C3E2C2",
  "#EAECCC",
  "#AFC8AD",
  "#EEC759",
  "#9BB8CD",
  "#FF90BC",
  "#FFC0D9",
  "#DC8686",
  "#7ED7C1",
  "#F3EEEA",
  "#89B9AD",
  "#D0BFFF",
  "#FFF8C9",
  "#CBFFA9",
  "#9BABB8",
  "#E3F4F4",
]

const names = [
  "Red Panda",
  "Snow Leopard",
  "Golden Eagle",
  "Sea Otter",
  "Kangaroo",
  "Orangutan",
  "Giant Tortoise",
  "Arctic Fox",
  "Blue Whale",
  "Cheetah",
  "Sloth Bear",
  "Green Sea Turtle",
  "Chimpanzee",
  "Great Horned Owl",
  "Grizzly Bear",
  "Komodo Dragon",
  "Emperor Penguin",
  "Okapi",
  "Axolotl",
  "Manatee",
  "White Tiger",
  "River Dolphin",
  "Meerkat",
  "Black Panther",
  "Koala",
]

const getRandomElement = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)]

export const getRandomColor = () => getRandomElement(colors)
export const getRandomName = () => getRandomElement(names)

export type Identity = { name: string; color: string }

export const getInitialUser = (): Identity => ({
  name: getRandomName(),
  color: getRandomColor(),
})

/**
 * Persisted "this device" identity for anonymous guests on a shared note —
 * unlike `getInitialUser`, this survives reloads so a guest's caret/avatar
 * stays recognizable across visits until they rename themselves.
 */
export function getOrCreateGuestIdentity(): Identity {
  let name = localStorage.getItem(NAME_KEY)
  let color = localStorage.getItem(COLOR_KEY)

  if (!name || !color) {
    name = name ?? getRandomName()
    color = color ?? getRandomColor()
    localStorage.setItem(NAME_KEY, name)
    localStorage.setItem(COLOR_KEY, color)
  }

  return { name, color }
}

export function setGuestName(name: string) {
  const trimmed = name.trim()
  if (!trimmed) return
  localStorage.setItem(NAME_KEY, trimmed)
}
