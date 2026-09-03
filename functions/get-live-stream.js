export async function onRequest(context) {
  // ⚠️ REPLACE WITH YOUR ACTUAL GITHUB USERNAME AND REPO NAME
  const rawJsonUrl = "https://mstvnetwork.github.io/mstv7/playlist.json";
  
  let schedule = [];
  try {
    const response = await fetch(rawJsonUrl);
    schedule = await response.json();
  } catch (err) {
    schedule = [{ startHour: 0, startMinute: 0, title: "Offline Loop", url: "https://mux.dev" }];
  }

  // Pure UTC Clock scheduling calculations
  const now = new Date();
  const currentSecondsInDay = (now.getUTCHours() * 3600) + (now.getUTCMinutes() * 60) + now.getUTCSeconds();

  let currentShow = schedule[0]; 
  let showStartSecondsInDay = 0;

  for (let i = 0; i < schedule.length; i++) {
    const showSeconds = (schedule[i].startHour * 3600) + (schedule[i].startMinute * 60);
    if (currentSecondsInDay >= showSeconds) {
      currentShow = schedule[i];
      showStartSecondsInDay = showSeconds;
    }
  }

  const playedSeconds = currentSecondsInDay - showStartSecondsInDay;

  return new Response(JSON.stringify({
    title: currentShow.title,
    url: currentShow.url,
    played: playedSeconds
  }), {
    headers: { 
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*" 
    }
  });
}
