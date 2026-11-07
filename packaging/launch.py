"""Entry script for PyInstaller (absolute import, so the package is collected as a package)."""
import sys

from lumo_materials.app import main

if __name__ == "__main__":
    sys.exit(main())
