/**
 * PrismClient — shared JS module for all Prism dashboard pages.
 * Handles SSE connection, entry management, and API calls.
 */
export class PrismClient {
  constructor(basePath) {
    this.basePath = basePath || new URL(".", location.href).pathname.replace(/\/$/, "");
    this.entries = new Map();
    this._listeners = [];
    this._es = null;
  }

  connect() {
    this._es = new EventSource(this.basePath + "/events");

    this._es.addEventListener("request", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.entries) {
          data.entries.forEach((entry) => {
            if (!this.entries.has(entry.id)) {
              this.entries.set(entry.id, entry);
              this._listeners.forEach((cb) => cb(entry));
            }
          });
        }
      } catch {}
    });

    this._es.onopen = () => {
      if (this.onStatusChange) this.onStatusChange(true);
    };

    this._es.onerror = () => {
      if (this.onStatusChange) this.onStatusChange(false);
    };
  }

  onEntry(callback) {
    this._listeners.push(callback);
  }

  getEntries() {
    return this.entries;
  }

  async fetchEntry(id) {
    const res = await fetch(`${this.basePath}/entry/${id}`);
    if (!res.ok) return null;
    return res.json();
  }

  async fetchHistory() {
    const res = await fetch(`${this.basePath}/history`);
    return res.json();
  }

  async fetchSummary() {
    const res = await fetch(`${this.basePath}/history/summary`);
    return res.json();
  }

  async fetchHealth() {
    const res = await fetch(`${this.basePath}/health`);
    return res.json();
  }

  async replay(id) {
    const res = await fetch(`${this.basePath}/replay/${id}`, { method: "POST" });
    return res.json();
  }

  async importCurl(cmd) {
    const res = await fetch(`${this.basePath}/import/curl`, {
      method: "POST",
      body: cmd,
      headers: { "content-type": "text/plain" },
    });
    return res.json();
  }

  async getRules() {
    const res = await fetch(`${this.basePath}/rules`);
    return res.json();
  }

  async addRule(rule) {
    const res = await fetch(`${this.basePath}/rules`, {
      method: "POST",
      body: JSON.stringify(rule),
      headers: { "content-type": "application/json" },
    });
    return res.json();
  }

  async deleteRule(index) {
    const res = await fetch(`${this.basePath}/rules/${index}`, { method: "DELETE" });
    return res.json();
  }

  async getRoutes() {
    const res = await fetch(`${this.basePath}/routes`);
    return res.json();
  }

  async addRoute(route) {
    const res = await fetch(`${this.basePath}/routes`, {
      method: "POST",
      body: JSON.stringify(route),
      headers: { "content-type": "application/json" },
    });
    return res.json();
  }

  async updateRoute(index, route) {
    const res = await fetch(`${this.basePath}/routes/${index}`, {
      method: "PUT",
      body: JSON.stringify(route),
      headers: { "content-type": "application/json" },
    });
    return res.json();
  }

  async deleteRoute(index) {
    const res = await fetch(`${this.basePath}/routes/${index}`, { method: "DELETE" });
    return res.json();
  }

  async testRoute(data) {
    const res = await fetch(`${this.basePath}/routes/test`, {
      method: "POST",
      body: JSON.stringify(data),
      headers: { "content-type": "application/json" },
    });
    return res.json();
  }

  async uploadFiles(filesMap, name) {
    const res = await fetch(`${this.basePath}/routes/upload-files`, {
      method: "POST",
      body: JSON.stringify({ name, files: filesMap }),
      headers: { "content-type": "application/json" },
    });
    return res.json();
  }

  async uploadArchive(file) {
    const res = await fetch(`${this.basePath}/routes/upload-archive`, {
      method: "POST",
      body: file,
      headers: { "x-archive-name": file.name || "archive" },
    });
    return res.json();
  }

  exportArchiveUrl(index) {
    return `${this.basePath}/routes/${index}/export`;
  }

  exportUrl(format) {
    return `${this.basePath}/export/${format}`;
  }
}
