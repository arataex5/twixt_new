@echo off
cd /d "%~dp0"
echo [1/5] move workflows to .github\workflows
if exist github-workflows (
  if not exist .github mkdir .github
  move /Y github-workflows .github\workflows
)
echo [2/5] git init
if not exist .git (
  git init
  git branch -M main
  git remote add origin https://github.com/arataex5/twixt_new.git
)
echo [3/5] git add
git add -A
echo [4/5] git commit
git commit -m "Scaffold: core rules, local play, PWA, Capacitor, Actions"
echo [5/5] git push
git push -u origin main
echo.
echo DONE. Open https://github.com/arataex5/twixt_new/actions
pause
