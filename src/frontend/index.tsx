import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(<App />);

// Ana ekrana kurulabilmesi ve sunucuya ulaşılamadığında kabuğun açılabilmesi için.
// Kayıt başarısız olursa uygulama normal çalışmaya devam eder.
if ("serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
