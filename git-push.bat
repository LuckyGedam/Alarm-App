@echo off
cd C:\Users\ASUS\Downloads\ALARM\alarm-app
rm -f .git\index.lock
git init
git add -A
git diff --cached --quiet || git commit -m "Deploy update: %date% %time%"
git branch -M main
git remote add origin https://github.com/LuckyGedam/Alarm-App.git 2>nul || git remote set-url origin https://github.com/LuckyGedam/Alarm-App.git
git push -u origin main
echo "Push complete!"
