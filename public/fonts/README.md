# Self-hosted fonts

Geist Sans and Geist Mono, Latin subset only, variable weight 100-900.

These are copied from the `@fontsource-variable/geist` and
`@fontsource-variable/geist-mono` packages rather than imported from them.
Importing the package CSS would make Vite bundle every subset it references
(Cyrillic, Greek, Vietnamese, symbols) into the APK — roughly half a megabyte
of glyphs this app never renders. Only the two Latin files are shipped.

They are served from `/fonts/` rather than from Google Fonts because this is
a Capacitor app: a webfont fetched over the network silently falls back to the
system sans whenever the user is offline, which is a state the app explicitly
supports and even displays a banner for.

Licence: SIL Open Font License 1.1, see GEIST-LICENSE.txt.
To update, bump the packages and re-copy the two `*-latin-wght-normal.woff2`
files.
