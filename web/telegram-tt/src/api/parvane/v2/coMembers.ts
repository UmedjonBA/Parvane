// Участники общих групп (spec 007, T185): кому можно раздавать ключ доступа к доставке.

type GroupLike = {
  deleted?: boolean;
  publicName?: string | null;
  members: { user: string }[];
};

/**
 * Участники групп, где состоит `self`, без самого `self`. `isPrivateOnly` — только закрытые группы:
 * в публичную может вступить кто угодно, и «общая группа» там ничего не говорит о знакомстве.
 */
export function coMembersOf(groups: (GroupLike | undefined)[], self: string, isPrivateOnly = false) {
  const out = new Set<string>();
  groups.forEach((g) => {
    if (!g || g.deleted || !g.members.some(({ user }) => user === self)) return;
    if (isPrivateOnly && g.publicName) return;
    g.members.filter(({ user }) => user !== self).forEach(({ user }) => out.add(user));
  });
  return out;
}
