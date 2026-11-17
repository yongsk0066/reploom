import { useEffect, useEffectEvent, useState } from "react";

export default function App() {
  const [room, setRoom] = useState("Studio");
  const [theme, setTheme] = useState("light");
  const [connections, setConnections] = useState(0);
  const [message, setMessage] = useState("");

  const announce = useEffectEvent((connectedRoom: string) => {
    setMessage(`${connectedRoom} connected using ${theme} theme`);
  });

  useEffect(() => {
    setConnections((count) => count + 1);
    const timer = setTimeout(() => announce(room), 300);
    return () => clearTimeout(timer);
  }, [room]);
  return (
    <main style={{ font: "16px system-ui", padding: 24 }}>
      <h1>Effect Events</h1>
      <label>
        Room{" "}
        <select value={room} onChange={(event) => setRoom(event.target.value)}>
          <option>Studio</option>
          <option>Garden</option>
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={theme === "dark"}
          onChange={(event) => setTheme(event.target.checked ? "dark" : "light")}
        />
        Dark theme
      </label>
      <p>Connections: {connections}</p>
      <output>{message}</output>
    </main>
  );
}
