"""`python -m lesswrong_mcp` entry point — delegate to the package's main().

Replaces the old `python lesswrong_mcp.py` file invocation now that the module is a package.
The console script `lesswrong-mcp` (pyproject [project.scripts]) is the other supported
launcher; both call the same main().
"""
from lesswrong_mcp.cli import main

if __name__ == "__main__":
    main()
