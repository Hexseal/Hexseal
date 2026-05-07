"use client";

import React from "react";
import { appChain, appChainId } from "@/config/chain";

export default function Footer() {
  return (
    <footer className="site-footer" role="contentinfo">
      <div className="footer-inner">
        <div className="footer-col">
          <h4>Signature404</h4>
          <p>Shaping tomorrow's digital reality through on-chain guarantees and world‑class engineering.</p>
        </div>
        <div className="footer-col">
          <h4>Resources</h4>
          <ul>
            <li><a href="#" rel="noopener noreferrer">Docs</a></li>
            <li><a href="#" rel="noopener noreferrer">Whitepaper</a></li>
            <li><a href="#" rel="noopener noreferrer">Changelog</a></li>
          </ul>
        </div>
        <div className="footer-col">
          <h4>Connect</h4>
          <ul>
            <li><a href="https://github.com/" target="_blank" rel="noopener noreferrer">GitHub</a></li>
            <li><a href="#" rel="noopener noreferrer">X / Twitter</a></li>
            <li><a href="#" rel="noopener noreferrer">Contact</a></li>
          </ul>
        </div>
      </div>
      <div className="footer-bottom">
        <span>© {new Date().getFullYear()} Signature404</span>
        <span>{appChain.name} · ChainId {appChainId}</span>
      </div>
    </footer>
  );
}
