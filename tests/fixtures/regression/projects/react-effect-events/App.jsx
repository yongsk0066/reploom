import { useState, useEffect } from "react";
import { useEffectEvent } from "react";
import { createConnection } from "./connection.js";
import { showNotification } from "./notifications.js";

function ChatRoom({ roomId, theme }) {
  const onConnect = useEffectEvent(() => {
    showNotification("Connection ready", theme);
  });
  const onDisconnect = useEffectEvent(() => {
    showNotification("Connection closed", theme);
  });

  useEffect(() => {
    const connection = createConnection(roomId);
    connection.on("connected", () => {
      onConnect();
    });
    connection.connect();
    return () => {
      onDisconnect();
      connection.disconnect();
    };
  }, [roomId]);

  return <h1>Room: {roomId}</h1>;
}

export default function App() {
  const [roomId, setRoomId] = useState("general");
  const [isDark, setIsDark] = useState(false);
  return (
    <>
      <label>
        Choose the chat room:{" "}
        <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
          <option value="general">general</option>
          <option value="travel">travel</option>
          <option value="music">music</option>
        </select>
      </label>
      <label>
        <input type="checkbox" checked={isDark} onChange={(e) => setIsDark(e.target.checked)} />
        Use dark theme
      </label>
      <hr />
      <ChatRoom roomId={roomId} theme={isDark ? "dark" : "light"} />
    </>
  );
}
