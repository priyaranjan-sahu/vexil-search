<div align="center">
  
# 🔮 Vexil Search

**The Search Engine for Your Local Brain.**

[![Release](https://img.shields.io/github/v/release/priyaranjan-sahu/vexil-search?label=latest%20release&style=for-the-badge&color=6366f1)](https://github.com/priyaranjan-sahu/vexil-search/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-a855f7?style=for-the-badge)](https://github.com/priyaranjan-sahu/vexil-search/releases)
[![Engine](https://img.shields.io/badge/engine-Rust%20%2B%20Tauri-ec4899?style=for-the-badge)](https://github.com/priyaranjan-sahu/vexil-search)

<br/>

Vexil is an ultra-fast, privacy-centric desktop application that indexes your local files and uses intelligent parsing to help you instantly locate code, documents, and data—all without ever sending a single byte to the cloud.

[**Visit the Website**](https://priyaranjan-sahu.github.io/vexil-search/) • [**Download Latest Release**](https://github.com/priyaranjan-sahu/vexil-search/releases/latest)

<br/>
</div>

---

### ⚡ Engineered for Performance
Vexil's backend is powered entirely by **Rust** using the Tauri framework. By strict separation of concerns, the frontend UI remains blazing fast and completely unblocked while the multi-threaded Rust engine churns through gigabytes of local data, parsing and indexing file contents with near-zero latency.

### 🔒 Absolute Privacy Guarantee
Your data is yours. Vexil operates 100% offline. There are no cloud telemetry trackers, no data collection, no background analytics, and your sensitive proprietary code never leaves your local hard drive. 

### 🧠 Smart AI Indexing
Stop relying on strict, literal keyword matches. Vexil intelligently categorizes your codebase and documents to surface what actually matters, understanding the context of your files seamlessly.

<br/>

---

## 📥 Installation

Vexil is compiled into highly optimized native bundles via an automated CI/CD pipeline. 

1. Navigate to our [Releases Page](https://github.com/priyaranjan-sahu/vexil-search/releases/latest).
2. Download the installer for your operating system:
   - **Windows:** Download the `.msi` file.
   - **macOS:** Download the `.app` bundle (Universal Binary for both Apple Silicon & Intel).
   - **Linux:** Download the `.deb` file.
3. Run the installer and launch Vexil. It will securely live in your System Tray, ready whenever you need it.

---

## 🏗️ CI/CD Architecture (For AI Agents / Maintainers)

> [!IMPORTANT]
> **Source Code Does Not Belong Here!**

This public repository (`vexil-search`) acts **exclusively** as a public mirror for the GitHub Pages marketing site and the automated GitHub Actions CI/CD release pipeline. 

To bypass GitHub Action billing limits on private repositories, the `.github/workflows/builder.yml` in this repository securely checks out the private source code repository (`vexil`) using a `PRIVATE_REPO_TOKEN`. It builds the Universal Binaries and drafts the GitHub Release *here* on the public repository.

**Rules:**
1. Never push or copy source code (`src`, `src-tauri`, etc.) to this public repository.
2. The private repository (`vexil`) is the sole source of truth for the codebase.
3. To trigger a new release, simply run the `builder.yml` workflow on this repository.

---

<div align="center">
<br/>
<i>Designed for developers. Built for speed.</i>
<br/>
<br/>
<b>Vexil Search © 2026</b>
</div>
