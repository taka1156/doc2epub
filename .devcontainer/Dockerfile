FROM node:24-slim

WORKDIR /workspace

RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  bash-completion \
  ca-certificates \
  tzdata \
  git \
  git-lfs \
  vim \
  curl \
  locales \
  calibre \
  python3 \
  && rm -rf /var/lib/apt/lists/*

RUN git lfs install

RUN <<-EOF
	set -eux
	sed -i -E 's/^# *(ja_JP.UTF-8 UTF-8)/\1/' /etc/locale.gen
	sed -i -E 's/^# *(en_US.UTF-8 UTF-8)/\1/' /etc/locale.gen
	locale-gen
	update-locale LANG=ja_JP.UTF-8
EOF

RUN <<-EOF
curl -o ~/.git-prompt.sh https://raw.githubusercontent.com/git/git/master/contrib/completion/git-prompt.sh
curl -o ~/.git-completion.sh https://raw.githubusercontent.com/git/git/master/contrib/completion/git-completion.bash

echo "[ -f ~/.git-prompt.sh ] && source ~/.git-prompt.sh" >> ~/.bashrc
echo "[ -f ~/.git-completion.sh ] && source ~/.git-completion.sh" >> ~/.bashrc
echo "GIT_PS1_SHOWDIRTYSTATE=true" >> ~/.bashrc
echo "GIT_PS1_SHOWUNTRACKEDFILES=true" >> ~/.bashrc
echo "GIT_PS1_SHOWUPSTREAM=auto"  >> ~/.bashrc
git config --system --add safe.directory /workspace
echo 'export PS1="\[\033[01;32m\]\u@\h\[\033[01;33m\] \w \[\033[01;31m\]\$(__git_ps1 \"(%s)\") \\n+\[\033[01;34m\]\\$ \[\033[00m\]"' >> ~/.bashrc
EOF

CMD ["bash"]
