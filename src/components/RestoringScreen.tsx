/** Shown in place of the app for the moment a reinstall's library is being restored (see main.tsx). */
export default function RestoringScreen() {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, textAlign: "center" }}>
      <p className="muted">Restoring your library from your Android backup...</p>
    </div>
  );
}
