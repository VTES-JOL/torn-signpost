# Roles and privileges

What each kind of user may do, as built. **Keep this up to date:** any change that gives a role a
new power, takes one away, or adds a role updates this page in the same change (and the
"Docs to update" list of the current milestone plan names it).

Where a check lives is noted in brackets: **engine** (`packages/engine/src/decide.ts`, so it holds
however a command arrives), **API** (`services/backend`), or **web** (`apps/web`, which only hides
what the API or engine would refuse anyway).

## How roles are given

- **Judge** and **admin** are Cognito user-pool groups (`judge`, `admin`; `infra/lib/auth-stack.ts`).
  They're granted by hand, in the Cognito console or with
  `aws cognito-idp admin-add-user-to-group`; there is no in-app screen for it yet. A user's groups
  arrive in their ID token, so a change takes effect when they next sign in.
- The two are independent: an admin has no judge powers unless also in `judge`, and the reverse.
- Locally, dev tokens carry groups: `dev:jo:judge`, `dev:ada:admin`, `dev:sam:judge,admin`.
- A judge or admin who **holds a seat** in a game acts in it as that player, with a player's
  powers only [API].

## Guests (not signed in)

- Browse cards and public decks; watch public games, seeing only public information (GAME-16)
  [API, engine projection].
- Nothing else: every change needs a signed-in user [API].

## Players (signed in)

- **Lobby**: create games; join and leave open ones; start a game they created [API].
- **At their seat** (GAME-10) [engine]: anything on their own cards and zones and on public ones;
  never another player's hidden zones. The structured flow: phases, actions, blocks, passes,
  holds, auto-pass and stops.
- **Chat** in games they're seated in (or have joined) [API]. `@name` mentions notify.
- **Call a judge**, one open call each (GAME-18) [engine].
- **Pause** a game with a table timer for 1–5 minutes, up to 15 minutes in all per game, and lift
  their own pause early (TEMPO-05) [engine].
- **Withdraw** with an empty library and less than a full hand, in their own unlock phase; they
  leave with ½ VP at the start of their next turn if it still holds (GAME-09) [engine].
- **End a casual game by agreement**: propose, agree or decline; it ends once everyone still in it
  agrees (docs/m6-plan.md Q3) [engine]. Not in tournament games.
- **Their own account**: choose a display name once (AUTH-05); notifications; email settings and
  unsubscribing [API].
- See private games they've joined or sat in [API].

## Spectators (signed in, not seated)

- Watch public games as guests do, and count in the audience shown at the table (TEMPO-06) [API].
- No chat, no commands [API, engine].

## Judges (`judge` group)

- **Any game, without a seat** [API]: see private games; chat; act as a judge.
- **Every primitive, on any seat** (GAME-10): move, lock, adjust counters and pools, reveal, and
  the rest, including other players' hidden zones; each change is logged as the judge's [engine].
- **Look at hidden cards** with `JudgeReveal`; judges see the cards they've looked at, players
  don't (GAME-03, §4.5) [engine projection].
- **Judge calls** (GAME-18) [engine, API]: see the judge queue (`GET /judge/calls`, the `/judge`
  page); claim calls; rule: answered, more time for an away player's decision, pass for the
  player holding the impulse, add time to the timer (timed games), disqualify (tournament games),
  refer to the admins (casual games).
- **Pause** without the players' allowance, and **lift anyone's pause** [engine].
- **Notified** of every new judge call, if they've connected in the last 30 days [API].
- Not: end games, replace players, rename players (admin powers).

## Admins (`admin` group)

- **Any game, without a seat** [API]: see private games. (Chat needs a seat or the judge group.)
- **Start any open game**, not only their own [API].
- **Replace a player** in a casual game with a willing one (GAME-19), from the admin queue
  (`/admin`, by display name) or the console's `replace` [engine, API].
- **End a game**, scored as a timeout: everyone still in it gains ½ VP (docs/m6-plan.md M6.1)
  [engine, API].
- **The admin queue** (`GET /admin/escalations`, `/admin`): games a judge referred to the admins;
  replace the player or dismiss it [API].
- **Rename a player** (AUTH-05): names are otherwise permanent; the old name stays retired
  (`PUT /users/{name}/name`, the Account page) [API].
- **Notified** of every escalation, if they've connected in the last 30 days [API].
- Not: judge powers (rulings, hidden cards, primitives on other seats) unless also a judge.

## The system (the server itself)

Commands no user can send [engine]: starting a game (`StartGame`), presence (`SetPresence`), and
the timer checks (`CheckDeadline`, `CheckTimeLimit`, `EndPause`). After every command the engine
also applies the rules no one asks for: automatic passes, ousts, settling deadline calls, and the
end of the game.
