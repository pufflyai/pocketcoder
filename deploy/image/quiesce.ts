const response = await fetch("http://127.0.0.1:3284/quiesce", { method: "POST" });
if (!response.ok) throw new Error(`Session quiescence failed (${response.status})`);
