function send(msg, cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, msg, cb);
  });
}
function setActive(mode) {
  document.getElementById("hint").classList.toggle("active", mode === "hint");
  document.getElementById("solver").classList.toggle("active", mode === "solver");
}
document.getElementById("hint").onclick = () => { setActive("hint"); send({ type: "setMode", mode: "hint" }); };
document.getElementById("solver").onclick = () => { setActive("solver"); send({ type: "setMode", mode: "solver" }); };
document.getElementById("toggle").onclick = () => send({ type: "toggle" });

send({ type: "getState" }, (resp) => {
  const s = document.getElementById("status");
  if (chrome.runtime.lastError || !resp) { s.textContent = "No Wordle game on this tab."; return; }
  setActive(resp.mode);
  s.textContent = resp.detected ? `Board detected • ${resp.remaining} possible words` : "No Wordle board found on this page.";
});
