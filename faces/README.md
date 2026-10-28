# Identity folder

Create one sub-folder per person and drop 3–10 clear photos of their face in it:

```
faces/
├── Alice/
│   ├── 01.jpg
│   └── 02.png
└── Bob/
    └── portrait.jpg
```

Then click **Re-index** on the *Identities* page (or just start a source – new
photos are indexed automatically). Embeddings are cached in
`%LOCALAPPDATA%\Veil\embeddings`, so only new or changed photos are processed.

Everything in this folder except this README is ignored by git: face photos are
biometric personal data.
