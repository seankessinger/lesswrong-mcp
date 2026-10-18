"""`python -m lesswrong_mcp` entry point — delegate to the package's main().

The console script `lesswrong-mcp` (pyproject [project.scripts]) is the other supported
launcher; both call the same main().
"""
from lesswrong_mcp.cli import main

if __name__ == "__main__":
    main()
